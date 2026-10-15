import { test, expect } from 'bun:test';
import { DatabaseManager } from '../../db/index';
import { recordEpisodeSearchMiss, SEARCH_BACKOFF_MINUTES } from '../../db/grabs';
import { getEpisodeStatus } from '../../db/episode_status';
import { isDueForSearch, GRAB_INFLIGHT_HOURS } from '../auto_grabber';
import {
  explainEpisodes,
  explainEpisode,
  listAttention,
  getPipelineSummary,
  listKanbanEpisodes,
  keyOf,
  type ExplainInput,
  type ExplainedEpisode,
} from './explain';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function freshDb() {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Alpha Show', config: {} });
  db.saveShow({ uuid: 'm1', providerId: 'pm', type: 'tmdb', title: 'A Movie', config: {}, seriesType: 'movie' });
  return db;
}

function addEp(db: DatabaseManager, ep: number, opts: { air?: string | null; expected?: string | null; tracked?: boolean; mode?: string; file?: string; season?: number } = {}) {
  const season = opts.season ?? 1;
  db.saveEpisode({ showId: 's1', seasonNumber: season, episodeNumber: ep, title: `E${ep}`, airDate: opts.air ?? '', ...(opts.file ? { filePath: opts.file } : {}) });
  if (opts.expected) db.updateEpisodeAirWindow('s1', season, ep, { expectedReleaseAt: opts.expected });
  db.setTracked('s1', season, ep, opts.tracked ?? true);
  if (opts.mode) db.updateEpisodeSearchMode('s1', season, ep, opts.mode);
}

function byEp(list: ExplainedEpisode[], ep: number, season = 1) {
  return list.find(e => e.showId === 's1' && e.season === season && e.episode === ep)!;
}

function explainAll(db: DatabaseManager, now: number, live?: Map<string, { state: string; progress: number | null }>) {
  return explainEpisodes(db, { pipelineOnly: false }, { nowMs: now, live, nextAutoGrabAt: null });
}

// ---- explainEpisode per state ---------------------------------------------

test('explain: not_tracked, manual_only, waiting_air (date + TBA), waiting_release_delay, searching, done', () => {
  const db = freshDb();
  const now = Date.now();
  addEp(db, 1, { air: iso(now - 3 * HOUR), expected: iso(now - 2 * HOUR), tracked: false });
  addEp(db, 2, { air: iso(now - 3 * HOUR), expected: iso(now - 2 * HOUR), mode: 'interactive' });
  addEp(db, 3, { air: iso(now + 3 * 24 * HOUR), expected: iso(now + 3 * 24 * HOUR + 45 * 60_000) });
  addEp(db, 4, { air: '' });
  addEp(db, 5, { air: iso(now - 10 * 60_000), expected: iso(now + 35 * 60_000) });
  addEp(db, 6, { air: iso(now - 3 * HOUR), expected: iso(now - 2 * HOUR) });
  addEp(db, 7, { air: iso(now - 3 * HOUR), expected: iso(now - 2 * HOUR), file: '/m/e7.mkv' });

  const all = explainAll(db, now);
  expect(byEp(all, 1).state).toBe('not_tracked');
  expect(byEp(all, 1).action).toBe('open_show');
  expect(byEp(all, 2).state).toBe('manual_only');
  expect(byEp(all, 2).action).toBe('change_search_mode');
  const e3 = byEp(all, 3);
  expect(e3.state).toBe('waiting_air');
  expect(e3.detail).toMatch(/^Waiting for air on \d{1,2} \w{3}/);
  expect(e3.nextCheckAt).not.toBeNull();
  expect(byEp(all, 4).state).toBe('waiting_air');
  expect(byEp(all, 4).blocker).toBe('no_air_date');
  expect(byEp(all, 5).state).toBe('waiting_release_delay');
  const e6 = byEp(all, 6);
  expect(e6.state).toBe('searching');
  expect(e6.dueNow).toBe(true);
  expect(e6.action).toBe('search_now');
  expect(byEp(all, 7).state).toBe('done');
  db.close();
});

test('explain: not_found reports attempts, profile rejections and next retry from the backoff', () => {
  const db = freshDb();
  const now = Date.now();
  addEp(db, 1, { air: iso(now - 30 * HOUR), expected: iso(now - 29 * HOUR) });
  // A search that found releases but rejected all of them.
  db.logPipelineEvent({
    showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'SEARCHING', eventType: 'release_rejected',
    message: '3 release(s) rejected', metadata: { count: 3, breakdown: { QUALITY_NOT_ALLOWED: 2, FORBIDDEN_FORMAT_MATCHED: 1 } },
  });
  db.logPipelineEvent({
    showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'SEARCHING', eventType: 'search_completed',
    message: 'Queried 2 indexer(s), found 3 release(s), 0 passed filtering', metadata: { resultsFound: 3, passedFiltering: 0 },
  });
  db.logPipelineEvent({
    showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'WANTED', eventType: 'no_qualifying_releases',
    reasonCode: 'NO_RESULTS_FOUND', message: 'No qualifying releases',
  });
  for (let k = 0; k < 3; k++) recordEpisodeSearchMiss(db, 's1', 1, 1, iso(now - 10 * 60_000));
  const status = getEpisodeStatus(db, { showId: 's1', season: 1, episode: 1 })!;
  expect(status.state).toBe('not_found');
  expect(status.blocker).toBe('REJECTED_BY_PROFILE'); // no_qualifying didn't clobber the richer reason

  const e = byEp(explainAll(db, now), 1);
  expect(e.state).toBe('not_found');
  expect(e.attempts).toBe(3);
  expect(e.detail).toContain('Searched 3x, nothing matched your profile');
  expect(e.detail).toContain("2 quality not in this profile's allow-list");
  expect(e.detail).toMatch(/next try in 6h$/);
  expect(Date.parse(e.nextCheckAt!)).toBe(now - 10 * 60_000 + SEARCH_BACKOFF_MINUTES[2] * 60_000);
  expect(e.dueNow).toBe(false);

  // Once the backoff lapses it's searching again (still remembering the misses).
  const later = byEp(explainAll(db, now + 7 * HOUR), 1);
  expect(later.state).toBe('searching');
  expect(later.dueNow).toBe(true);
  expect(later.detail).toContain('Searched 3x');
  db.close();
});

test('explain: grabbed_downloading, live TorBox progress, stuck (no progress / torbox failed), importing', () => {
  const db = freshDb();
  const now = Date.now();
  for (const ep of [1, 2, 3, 4, 5]) addEp(db, ep, { air: iso(now - 30 * HOUR), expected: iso(now - 29 * HOUR) });
  for (const ep of [1, 2, 3, 4, 5]) db.recordGrabbedRelease({ showId: 's1', season: 1, episode: ep, releaseTitle: `Alpha Show S01E0${ep} 1080p WEB-DL` });
  // ep3: grab 7h ago, nothing since.
  db.db.run(`UPDATE grabbed_releases SET grabbed_at = ? WHERE episode_number = 3`, [iso(now - 7 * HOUR)]);
  // ep4: TorBox gave up.
  expect(db.setStatusForRelease('Alpha Show S01E04 1080p WEB-DL', { state: 'stuck', blocker: 'torbox_failed', detail: 'TorBox download failed' })).toBe(1);
  // ep5: import started.
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 5, stage: 'IMPORTING', eventType: 'import_started', message: 'Processing', releaseTitle: 'x.mkv' });

  const live = new Map([[keyOf('s1', 1, 2), { state: 'downloading', progress: 43 }]]);
  const all = explainAll(db, now, live);
  expect(byEp(all, 1).state).toBe('grabbed_downloading');
  expect(byEp(all, 1).dueNow).toBe(false);
  expect(byEp(all, 2).state).toBe('grabbed_downloading');
  expect(byEp(all, 2).detail).toBe('Downloading 43%');
  expect(byEp(all, 2).progress).toBe(43);
  expect(byEp(all, 3).state).toBe('stuck');
  expect(byEp(all, 3).blocker).toBe('no_progress');
  expect(byEp(all, 4).state).toBe('stuck');
  expect(byEp(all, 4).detail).toContain('Stuck: TorBox reports the download failed');
  expect(byEp(all, 4).action).toBe('retry');
  expect(byEp(all, 5).state).toBe('importing');

  // After the in-flight cooldown lapses auto-grab re-admits it -> searching.
  const after = explainAll(db, now + (GRAB_INFLIGHT_HOURS + 1) * HOUR);
  expect(byEp(after, 4).state).toBe('searching');
  db.close();
});

test('explain: pure function needs no db', () => {
  const now = Date.now();
  const input: ExplainInput = {
    showId: 'x', showTitle: 'X', season: 1, episode: 1, episodeTitle: null,
    airDate: iso(now - 5 * HOUR), airTime: null, expectedReleaseAt: null, releaseDelayMinutes: 30,
    searchMode: 'auto', isMovie: false, searchAttempts: 0, lastSearchedAt: null, filePath: null,
    gates: { tracked: true, autoMode: true, missing: true, notMovie: true, released: true, notInflight: true, outsideBackoff: true },
    lastGrabAt: null, status: { state: 'stuck', blocker: 'NO_INDEXERS_CONFIGURED', detail: 'No indexers', release_title: null, meta_json: null, since: iso(now - HOUR), updated_at: iso(now - HOUR) },
  };
  const e = explainEpisode(input, { nowMs: now });
  expect(e.state).toBe('stuck');
  expect(e.detail).toBe('Stuck: no indexers configured');
  expect(e.dueNow).toBe(true);
});

// ---- parity with listEpisodesDueForGrab -------------------------------------

test('parity: dueNow == listEpisodesDueForGrab + isDueForSearch, and dueNow eps never show a blocker state', () => {
  const db = freshDb();
  const now = Date.now();
  // Deterministic spread over every gate combination.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  for (let ep = 1; ep <= 160; ep++) {
    const airOffset = pick([-72, -5, -0.5, -0.1, 2, 48, null]);
    const air = airOffset == null ? pick(['', null]) : (rnd() < 0.3 ? iso(now + airOffset * HOUR).slice(0, 10) : iso(now + airOffset * HOUR));
    const expected = airOffset == null ? pick([null, iso(now - HOUR), iso(now + HOUR)]) : pick([null, iso(now + (airOffset + 0.75) * HOUR), iso(now - 2 * HOUR)]);
    addEp(db, ep, {
      air: air as string | null, expected,
      tracked: rnd() < 0.85, mode: rnd() < 0.15 ? 'interactive' : undefined,
      file: rnd() < 0.15 ? `/m/${ep}.mkv` : undefined,
    });
    const grab = rnd();
    if (grab < 0.15) db.recordGrabbedRelease({ showId: 's1', season: 1, episode: ep, releaseTitle: `Alpha Show S01E${ep}` });
    if (grab < 0.07) db.db.run(`UPDATE grabbed_releases SET grabbed_at = ? WHERE episode_number = ?`, [iso(now - 13 * HOUR), ep]);
    const misses = Math.floor(rnd() * 5);
    for (let k = 0; k < misses; k++) recordEpisodeSearchMiss(db, 's1', 1, ep, iso(now - pick([5, 30, 120, 500, 2000]) * 60_000));
  }
  // Movie-show episode row must never be due.
  db.saveEpisode({ showId: 'm1', seasonNumber: 1, episodeNumber: 1, title: 'M', airDate: iso(now - 5 * HOUR) });
  db.setTracked('m1', 1, 1, true);

  const due = db.listEpisodesDueForGrab(iso(now), iso(now - GRAB_INFLIGHT_HOURS * HOUR), 10_000)
    .filter(e => isDueForSearch(e, now))
    .map(e => keyOf(e.show_id, e.season_number, e.episode_number))
    .sort();
  const explained = explainEpisodes(db, { pipelineOnly: false }, { nowMs: now, nextAutoGrabAt: null });
  const explainedDue = explained.filter(e => e.dueNow).map(e => keyOf(e.showId, e.season, e.episode)).sort();
  expect(due.length).toBeGreaterThan(5);
  expect(explainedDue).toEqual(due);
  for (const e of explained) {
    if (e.dueNow) expect(e.state).toBe('searching');
    if (e.state === 'searching') expect(e.dueNow).toBe(true);
  }
  db.close();
});

test('explain: failed + blocklisted download re-searches (not stuck); season pack and failed grabs gate parity', () => {
  const db = freshDb();
  const now = Date.now();
  const aired = { air: iso(now - 30 * HOUR), expected: iso(now - 29 * HOUR) };
  addEp(db, 1, aired);
  addEp(db, 1, { ...aired, season: 2 });
  addEp(db, 2, { ...aired, season: 2 });
  addEp(db, 1, { ...aired, season: 3 });
  // S1E1: TorBox gave up -> grab failed + release blocklisted (core/release_failures).
  db.recordGrabbedRelease({ showId: 's1', season: 1, episode: 1, releaseTitle: 'Alpha Show S01E01 1080p WEB-DL' });
  const g = db.listRecentGrabs(10).find(r => r.season_number === 1 && r.episode_number === 1)!;
  db.markGrabFailed(g.id, 'torbox: dead');
  db.addToBlocklist({ showId: 's1', season: 1, episodes: [1], releaseTitle: g.release_title, infoHash: null, indexerName: null, reason: 'torbox: dead' });
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'FAILED', eventType: 'download_failed', reasonCode: 'RELEASE_FAILED_BLOCKLISTED', message: 'failed', releaseTitle: g.release_title });
  db.setStatusForRelease(g.release_title, { state: 'stuck', blocker: 'torbox_failed', detail: 'TorBox download failed' });
  // Season 2: a season-pack grab (episode NULL) holds every episode in flight.
  db.recordGrabbedRelease({ showId: 's1', season: 2, episode: null, releaseTitle: 'Alpha Show S02 1080p' });

  const all = explainAll(db, now);
  expect(byEp(all, 1).state).toBe('searching');
  expect(byEp(all, 1).dueNow).toBe(true);
  expect(byEp(all, 1).detail).toContain('Failed, blocklisted, re-searching');
  expect(byEp(all, 1, 2).state).toBe('grabbed_downloading');
  expect(byEp(all, 2, 2).dueNow).toBe(false);
  expect(byEp(all, 1, 3).dueNow).toBe(true);

  const due = db.listEpisodesDueForGrab(iso(now), iso(now - GRAB_INFLIGHT_HOURS * HOUR), 100)
    .filter(e => isDueForSearch(e, now)).map(e => keyOf(e.show_id, e.season_number, e.episode_number)).sort();
  expect(all.filter(e => e.dueNow).map(e => keyOf(e.showId, e.season, e.episode)).sort()).toEqual(due);
  expect(due).toEqual([keyOf('s1', 1, 1), keyOf('s1', 3, 1)].sort());
  db.close();
});

// ---- status transitions ------------------------------------------------------

test('status: grab -> importing -> done; failure -> stuck; season pack and movie events land on rows', () => {
  const db = freshDb();
  const now = Date.now();
  addEp(db, 1, { air: iso(now - 30 * HOUR) });
  addEp(db, 2, { air: iso(now - 30 * HOUR) });
  addEp(db, 3, { air: iso(now - 30 * HOUR), file: '/m/e3.mkv' });
  const st = (ep: number, season = 1) => getEpisodeStatus(db, { showId: 's1', season, episode: ep })?.state;

  db.recordGrabbedRelease({ showId: 's1', season: 1, episode: 1, releaseTitle: 'Alpha Show S01E01 1080p' });
  expect(st(1)).toBe('grabbed_downloading');
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'IMPORTING', eventType: 'import_started', message: 'go' });
  expect(st(1)).toBe('importing');
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'FAILED', eventType: 'import_failed', message: 'No root folder' });
  expect(st(1)).toBe('stuck');
  expect(getEpisodeStatus(db, { showId: 's1', season: 1, episode: 1 })!.detail).toBe('No root folder');
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 1, stage: 'AVAILABLE', eventType: 'import_completed', message: 'ok' });
  expect(st(1)).toBe('done');

  // Season-pack grab (episode null) -> every missing episode of the season, not the on-disk one.
  db.recordGrabbedRelease({ showId: 's1', season: 1, episode: null, releaseTitle: 'Alpha Show S01 1080p' });
  expect(st(2)).toBe('grabbed_downloading');
  expect(st(3)).toBeUndefined();
  // Season-level no-results event too.
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, stage: 'WANTED', eventType: 'no_qualifying_releases', reasonCode: 'NO_RESULTS_FOUND', message: 'none' });
  expect(st(2)).toBe('not_found');

  // Movie (show-level event) -> S0E0 row; shows up in the attention list as in flight.
  db.logPipelineEvent({ showId: 'm1', stage: 'IMPORTING', eventType: 'import_started', message: 'Processing movie' });
  expect(getEpisodeStatus(db, { showId: 'm1', season: 0, episode: 0 })?.state).toBe('importing');
  const movie = listAttention(db, { nowMs: now }).items.find(e => e.showId === 'm1');
  expect(movie?.state).toBe('importing');
  // Show-level events on a series are ignored (no row to land on).
  db.logPipelineEvent({ showId: 's1', stage: 'IMPORTING', eventType: 'import_started', message: 'x' });
  expect(getEpisodeStatus(db, { showId: 's1', season: 0, episode: 0 })).toBeNull();
  db.close();
});

test('status: event retention cleanup never reverts a stuck episode, prunes done rows', () => {
  const db = freshDb();
  const now = Date.now();
  addEp(db, 1, { air: iso(now - 30 * HOUR) });
  addEp(db, 2, { air: iso(now - 30 * HOUR), file: '/m/2.mkv' });
  db.recordGrabbedRelease({ showId: 's1', season: 1, episode: 1, releaseTitle: 'Alpha Show S01E01' });
  db.setStatusForRelease('Alpha Show S01E01', { state: 'stuck', blocker: 'torbox_failed', detail: 'dead' });
  db.logPipelineEvent({ showId: 's1', seasonNumber: 1, episodeNumber: 2, stage: 'AVAILABLE', eventType: 'import_completed', message: 'ok' });

  db.cleanupOldPipelineEvents(iso(now + HOUR)); // wipes every event + done rows older than cutoff
  expect(db.listRecentPipelineEvents(10).length).toBe(0);
  expect(getEpisodeStatus(db, { showId: 's1', season: 1, episode: 1 })?.state).toBe('stuck');
  expect(getEpisodeStatus(db, { showId: 's1', season: 1, episode: 2 })).toBeNull();
  expect(byEp(explainAll(db, now), 1).state).toBe('stuck');
  db.close();
});

// ---- attention / summary / kanban ---------------------------------------------

test('attention: oldest wait first, excludes done/untracked/far-future, paginates; summary + kanban agree', () => {
  const db = freshDb();
  const now = Date.now();
  addEp(db, 1, { air: iso(now - 10 * 24 * HOUR), expected: iso(now - 10 * 24 * HOUR) }); // oldest wait
  addEp(db, 2, { air: iso(now - 2 * 24 * HOUR), expected: iso(now - 2 * 24 * HOUR) });
  addEp(db, 3, { air: iso(now - 5 * HOUR), expected: iso(now - 4 * HOUR) });
  addEp(db, 4, { air: iso(now + 2 * 24 * HOUR), expected: iso(now + 2 * 24 * HOUR) }); // upcoming, in window
  addEp(db, 5, { air: iso(now + 30 * 24 * HOUR), expected: iso(now + 30 * 24 * HOUR) }); // too far out
  addEp(db, 6, { air: iso(now - 5 * HOUR), file: '/m/6.mkv' }); // done
  addEp(db, 7, { air: iso(now - 5 * HOUR), tracked: false }); // untracked
  db.recordGrabbedRelease({ showId: 's1', season: 1, episode: 2, releaseTitle: 'Alpha Show S01E02' });

  const page = listAttention(db, { nowMs: now, limit: 50 });
  const eps = page.items.map(e => e.episode);
  expect(eps.slice(0, 1)).toEqual([1]);
  expect(eps).toContain(2);
  expect(eps[eps.length - 1]).toBe(4); // upcoming sorts last
  expect(eps).not.toContain(5);
  expect(eps).not.toContain(6);
  expect(eps).not.toContain(7);
  expect(page.total).toBe(4);
  // wait ages descending (oldest first) among items that have one
  const waits = page.items.filter(e => e.waitingSince).map(e => Date.parse(e.waitingSince!));
  expect([...waits].sort((a, b) => a - b)).toEqual(waits);

  const p2 = listAttention(db, { nowMs: now, limit: 2, offset: 2 });
  expect(p2.items.map(e => e.episode)).toEqual(eps.slice(2, 4));
  expect(p2.hasMore).toBe(false);

  const summary = getPipelineSummary(db, now);
  const kanban = listKanbanEpisodes(db, { nowMs: now });
  expect(summary.needsAttention).toBe(page.total);
  expect(summary.total).toBe(kanban.length);
  expect(summary.attentionCount).toBe(kanban.filter(k => ['WANTED', 'SEARCHING', 'FAILED'].includes(k.currentStage)).length);
  expect(kanban.some(k => k.currentStage === 'AVAILABLE')).toBe(false);
  expect(listKanbanEpisodes(db, { nowMs: now, includeAvailable: true }).some(k => k.currentStage === 'AVAILABLE')).toBe(true);
  db.close();
});
