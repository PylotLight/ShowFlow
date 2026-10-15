import { test, expect, describe } from 'bun:test';
import { DatabaseManager } from '../db/index';
import type { ReleaseScore } from './quality_engine';
import { isCutoffMet, listCutoffUnmetEpisodes, isOutsideUpgradeBackoff, resolutionOf, type Scorer } from './cutoff';
import { isSeasonPackTitle } from './grabber_service';
import { shouldTrySeasonPack, runAutoGrabCycle, PACK_SETTLE_DAYS, type AutoGrabber } from './auto_grabber';
import type { SeasonAirStats } from '../db/grabs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Name-only scorer: rank from the resolution tag, mirrors the seeded ranks.
const RANKS: [RegExp, number, string][] = [
  [/2160p/i, 40, '2160p'],
  [/web-?dl.?1080p|1080p.?web-?dl/i, 33, 'WEBDL-1080p'],
  [/1080p/i, 30, '1080p'],
  [/720p/i, 20, '720p'],
];
function fakeScore(name: string): ReleaseScore {
  const hit = RANKS.find(([re]) => re.test(name));
  const rank = hit?.[1] ?? 0;
  return { rank, formatScore: 0, totalScore: rank * 1000, qualityName: hit?.[2], rejected: false, matchedTags: [] };
}
const scorer: Scorer = { byName: (n) => fakeScore(n), byMedia: () => fakeScore('') };

describe('isCutoffMet', () => {
  const cutoff = { rank: 33, name: 'WEBDL-1080p' };
  test('below cutoff is unmet', () => {
    expect(isCutoffMet({ rank: 20, qualityName: '720p' }, cutoff)).toBe(false);
    expect(isCutoffMet({ rank: 32, qualityName: 'WEBRip-1080p' }, cutoff)).toBe(false);
  });
  test('at or above cutoff stops', () => {
    expect(isCutoffMet({ rank: 33, qualityName: 'WEBDL-1080p' }, cutoff)).toBe(true);
    expect(isCutoffMet({ rank: 40, qualityName: '2160p' }, cutoff)).toBe(true);
  });
  test('a probed bare 1080p counts as the 1080p cutoff (source is unknowable)', () => {
    expect(isCutoffMet({ rank: 30, qualityName: '1080p' }, cutoff)).toBe(true);
  });
  test('unknown quality is never chased', () => {
    expect(isCutoffMet({ rank: 0, qualityName: null }, cutoff)).toBe(true);
  });
  test('resolutionOf', () => {
    expect(resolutionOf('WEBDL-1080p')).toBe(1080);
    expect(resolutionOf('SDTV')).toBe(480);
    expect(resolutionOf(null)).toBe(null);
  });
});

describe('isSeasonPackTitle', () => {
  test('whole-season packs', () => {
    expect(isSeasonPackTitle('Due.Show.S01.1080p.WEB-DL.x265-GRP', 1)).toBe(true);
    expect(isSeasonPackTitle('Due Show Season 2 Complete 1080p', 2)).toBe(true);
    expect(isSeasonPackTitle('Due Show S02 COMPLETE 2160p', 2)).toBe(true);
  });
  test('not packs: episodes, ranges, other season, multi-season', () => {
    expect(isSeasonPackTitle('Due.Show.S01E03.1080p', 1)).toBe(false);
    expect(isSeasonPackTitle('Due.Show.S01E01-E10.1080p', 1)).toBe(false);
    expect(isSeasonPackTitle('Due.Show.1x03.1080p', 1)).toBe(false);
    expect(isSeasonPackTitle('Due.Show.S02.1080p', 1)).toBe(false);
    expect(isSeasonPackTitle('Due.Show.S01-S03.1080p', 1)).toBe(false);
    expect(isSeasonPackTitle('Due Show Seasons 1-3 1080p', 1)).toBe(false);
  });
});

describe('shouldTrySeasonPack', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const stats = (o: Partial<SeasonAirStats> = {}): SeasonAirStats => ({
    total: 10, unaired: 0, lastAirDate: new Date(now - 30 * DAY).toISOString(), trackedWithFile: 0, missingTracked: 10, maxSeason: 1, ...o,
  });
  const base = { season: 1, seriesType: 'standard', mapped: false, minMissing: 2, nowMs: now };

  test('finished season with enough missing', () => {
    expect(shouldTrySeasonPack({ ...base, stats: stats() })).toBe(true);
  });
  test('still airing: unaired episodes or a fresh last episode', () => {
    expect(shouldTrySeasonPack({ ...base, stats: stats({ unaired: 3 }) })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, stats: stats({ lastAirDate: new Date(now - 2 * DAY).toISOString() }) })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, stats: stats({ lastAirDate: new Date(now - (PACK_SETTLE_DAYS + 1) * DAY).toISOString() }) })).toBe(true);
  });
  test('a later season existing means this one is done', () => {
    expect(shouldTrySeasonPack({ ...base, stats: stats({ lastAirDate: new Date(now - DAY).toISOString(), maxSeason: 2 }) })).toBe(true);
  });
  test('threshold, specials, absolute, mapped', () => {
    expect(shouldTrySeasonPack({ ...base, stats: stats({ missingTracked: 1 }) })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, minMissing: 4, stats: stats({ missingTracked: 3 }) })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, season: 0, stats: stats() })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, seriesType: 'absolute', stats: stats() })).toBe(false);
    expect(shouldTrySeasonPack({ ...base, mapped: true, stats: stats() })).toBe(false);
  });
});

// ---------- DB-backed ----------

function seedLibrary() {
  const db = new DatabaseManager(':memory:');
  db.saveQuality({ id: 'q_720p', name: '720p', rank: 20 });
  db.saveQuality({ id: 'q_1080p', name: '1080p', rank: 30 });
  db.saveQuality({ id: 'q_webdl_1080p', name: 'WEBDL-1080p', rank: 33 });
  db.saveProfile({ id: 'standard', name: 'Standard', cutoffId: 'q_webdl_1080p' });
  db.saveProfile({ id: 'nocut', name: 'No cutoff' });
  db.saveShow({ uuid: 'a', providerId: 'p1', type: 'tmdb', title: 'Alpha', config: {} });
  db.saveShow({ uuid: 'b', providerId: 'p2', type: 'tmdb', title: 'Beta', config: {} });
  db.db.query(`UPDATE shows SET profile = 'nocut' WHERE id = 'b'`).run();
  const past = new Date(Date.now() - 60 * DAY).toISOString();
  const ep = (show: string, n: number, file: string | null) => {
    db.saveEpisode({ showId: show, seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDate: past, ...(file ? { filePath: file } : {}) });
    db.setTracked(show, 1, n, true);
  };
  ep('a', 1, '/m/Alpha.S01E01.720p.HDTV.mkv');     // unmet
  ep('a', 2, '/m/Alpha.S01E02.1080p.WEB-DL.mkv');  // at cutoff
  ep('a', 3, '/m/Alpha.S01E03.2160p.mkv');         // above
  ep('a', 4, '/m/Alpha - S01E04 - Title.mkv');     // unknown quality
  ep('a', 5, '/m/Alpha.S01E05.720p.mkv');          // unmet, in flight
  ep('a', 6, null);                                // missing, not an upgrade candidate
  ep('b', 1, '/m/Beta.S01E01.720p.mkv');           // profile without cutoff
  db.recordGrabbedRelease({ showId: 'a', season: 1, episode: 5, releaseTitle: 'Alpha S01E05 1080p WEB-DL' });
  return db;
}

describe('listCutoffUnmetEpisodes', () => {
  test('selects only below-cutoff files of profiles with a cutoff', () => {
    const db = seedLibrary();
    const all = listCutoffUnmetEpisodes(db, { scorer });
    expect(all.map(e => `${e.showId}${e.episode}`).sort()).toEqual(['a1', 'a5']);
    expect(all[0]!.cutoffName).toBe('WEBDL-1080p');
    expect(all.find(e => e.episode === 1)!.currentQuality).toBe('720p');
    expect(all.find(e => e.episode === 1)!.existingScore).toBe(20_000);

    // in-flight grab drops E05 from the cycle pool
    const cooldownIso = new Date(Date.now() - 12 * HOUR).toISOString();
    expect(listCutoffUnmetEpisodes(db, { scorer, cooldownIso }).map(e => e.episode)).toEqual([1]);
    db.close();
  });

  test('stops once the file meets the cutoff', () => {
    const db = seedLibrary();
    db.saveEpisode({ showId: 'a', seasonNumber: 1, episodeNumber: 1, filePath: '/m/Alpha.S01E01.1080p.WEB-DL.mkv' });
    expect(listCutoffUnmetEpisodes(db, { scorer }).map(e => e.episode)).toEqual([5]);
    db.close();
  });

  test('upgrade backoff: 6h after the first miss, then longer', () => {
    const now = Date.now();
    expect(isOutsideUpgradeBackoff({ last_searched_at: null, search_attempts: 0 }, now)).toBe(true);
    expect(isOutsideUpgradeBackoff({ last_searched_at: new Date(now - 2 * HOUR).toISOString(), search_attempts: 1 }, now)).toBe(false);
    expect(isOutsideUpgradeBackoff({ last_searched_at: new Date(now - 7 * HOUR).toISOString(), search_attempts: 1 }, now)).toBe(true);
    expect(isOutsideUpgradeBackoff({ last_searched_at: new Date(now - 7 * HOUR).toISOString(), search_attempts: 2 }, now)).toBe(false);
    expect(isOutsideUpgradeBackoff({ last_searched_at: new Date(now - 8 * DAY).toISOString(), search_attempts: 9 }, now)).toBe(true);

    const db = seedLibrary();
    db.recordEpisodeSearchMiss('a', 1, 1);
    expect(listCutoffUnmetEpisodes(db, { scorer, applyBackoff: true }).map(e => e.episode)).toEqual([5]);
    db.close();
  });
});

// ---------- auto-grab cycle: packs + fallback + upgrade slice ----------

function seedSeason(opts: { lastAirDaysAgo: number; missing: number[]; total?: number }) {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's', providerId: 'p', type: 'tmdb', title: 'Pack Show', config: {} });
  const total = opts.total ?? 6;
  for (let n = 1; n <= total; n++) {
    const air = new Date(Date.now() - (opts.lastAirDaysAgo + (total - n) * 7) * DAY).toISOString();
    const missing = opts.missing.includes(n);
    db.saveEpisode({ showId: 's', seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDate: air, ...(missing ? {} : { filePath: `/m/e${n}.mkv` }) });
    db.updateEpisodeAirWindow('s', 1, n, { expectedReleaseAt: air });
    db.setTracked('s', 1, n, true);
  }
  return db;
}

function stubGrabber(o: { pack: boolean }) {
  const calls: string[] = [];
  const g: AutoGrabber = {
    grabSeasonPack: async (_s, season, eps) => { calls.push(`pack S${season} [${eps.join(',')}]`); return { success: o.pack, message: o.pack ? 'ok' : 'No season pack found' }; },
    grabBestRelease: async (_s, season, ep) => { calls.push(`ep S${season}E${ep}`); return { success: true, message: 'ok' }; },
    grabUpgradeRelease: async (_s, season, ep, score) => { calls.push(`up S${season}E${ep}>${score}`); return { success: false, message: 'Best found release (x) is not an upgrade over existing file.' }; },
  };
  return { g, calls };
}

const cfg = (o: Record<string, unknown> = {}) => ({ preferSeasonPacks: true, seasonPackMinMissing: 2, upgradeUntilCutoff: true, ...o }) as any;

describe('runAutoGrabCycle', () => {
  test('finished season with several missing: one pack covers them, no episode searches', async () => {
    const db = seedSeason({ lastAirDaysAgo: 30, missing: [2, 3, 5] });
    const { g, calls } = stubGrabber({ pack: true });
    const res = await runAutoGrabCycle(cfg(), null, { db, grabber: g, listUpgrades: () => [] });
    expect(calls).toEqual(['pack S1 [2,3,5]']);
    expect(res.packs).toBe(1);
    expect(res.packEpisodes).toBe(3);
    db.close();
  });

  test('no pack found: falls back to per-episode', async () => {
    const db = seedSeason({ lastAirDaysAgo: 30, missing: [2, 3] });
    const { g, calls } = stubGrabber({ pack: false });
    await runAutoGrabCycle(cfg(), null, { db, grabber: g, listUpgrades: () => [] });
    expect(calls[0]).toBe('pack S1 [2,3]');
    expect(calls.slice(1).sort()).toEqual(['ep S1E2', 'ep S1E3']);
    db.close();
  });

  test('season still airing / below threshold / packs off: straight to episodes', async () => {
    const airing = seedSeason({ lastAirDaysAgo: 1, missing: [5, 6] });
    const a = stubGrabber({ pack: true });
    await runAutoGrabCycle(cfg(), null, { db: airing, grabber: a.g, listUpgrades: () => [] });
    expect(a.calls.sort()).toEqual(['ep S1E5', 'ep S1E6']);
    airing.close();

    const one = seedSeason({ lastAirDaysAgo: 30, missing: [4] });
    const b = stubGrabber({ pack: true });
    await runAutoGrabCycle(cfg(), null, { db: one, grabber: b.g, listUpgrades: () => [] });
    expect(b.calls).toEqual(['ep S1E4']);
    one.close();

    const off = seedSeason({ lastAirDaysAgo: 30, missing: [2, 3] });
    const c = stubGrabber({ pack: true });
    await runAutoGrabCycle(cfg({ preferSeasonPacks: false }), null, { db: off, grabber: c.g, listUpgrades: () => [] });
    expect(c.calls.sort()).toEqual(['ep S1E2', 'ep S1E3']);
    off.close();
  });

  test('upgrade slice: capped, misses back off, disabled by setting', async () => {
    const db = seedSeason({ lastAirDaysAgo: 30, missing: [] });
    const pool = [1, 2, 3, 4, 5].map(n => ({
      showId: 's', showTitle: 'Pack Show', seriesType: null, profile: null, libraryTypeId: null,
      season: 1, episode: n, filePath: `/m/e${n}.mkv`, profileId: 'standard', profileName: 'Standard',
      cutoffName: 'WEBDL-1080p', currentQuality: '720p', existingScore: 20_000, lastSearchedAt: null, searchAttempts: 0,
    }));
    const { g, calls } = stubGrabber({ pack: false });
    const res = await runAutoGrabCycle(cfg(), null, { db, grabber: g, listUpgrades: () => pool });
    expect(calls).toEqual(['up S1E1>20000', 'up S1E2>20000', 'up S1E3>20000']);
    expect(res.upgradeSearched).toBe(3);
    const row = db.db.query(`SELECT search_attempts, last_searched_at FROM episodes WHERE show_id='s' AND episode_number=1`).get() as any;
    expect(row.search_attempts).toBe(1);
    expect(row.last_searched_at).not.toBeNull();

    const off = stubGrabber({ pack: false });
    await runAutoGrabCycle(cfg({ upgradeUntilCutoff: false }), null, { db, grabber: off.g, listUpgrades: () => pool });
    expect(off.calls).toEqual([]);
    db.close();
  });

  test('a season-pack grab holds every episode of the season in flight', () => {
    const db = seedSeason({ lastAirDaysAgo: 30, missing: [2, 3] });
    const nowIso = new Date().toISOString();
    const cooldownIso = new Date(Date.now() - 12 * HOUR).toISOString();
    expect(db.listEpisodesDueForGrab(nowIso, cooldownIso, 50)).toHaveLength(2);
    db.recordGrabbedRelease({ showId: 's', season: 1, releaseTitle: 'Pack Show S01 1080p' });
    expect(db.listEpisodesDueForGrab(nowIso, cooldownIso, 50)).toHaveLength(0);
    db.close();
  });
});
