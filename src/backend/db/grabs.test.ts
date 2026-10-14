import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DatabaseManager } from './index';
import * as schema from './schema';
import { recordGrabbedRelease, findGrabbedReleaseForEpisode, normalizeReleaseTitle } from './grabs';

test('normalizeReleaseTitle reduces release names to searchable tokens', () => {
  expect(normalizeReleaseTitle('The.Show.S01E02.1080p.WEB-DL.x264'))
    .toBe('the show s01e02 1080p web dl x264');
  expect(normalizeReleaseTitle('My_Show_EP03_[Group]')).toBe('my show ep03 group');
});

test('recordGrabbedRelease + findGrabbedReleaseForEpisode round-trips most recent first', () => {
  const db = new DatabaseManager(':memory:');

  recordGrabbedRelease(db, {
    showId: 'show-1',
    season: 2,
    episode: 3,
    releaseTitle: 'Some Show S02E03 1080p WEB-DL x264',
    indexerName: 'test-indexer',
  });
  recordGrabbedRelease(db, {
    showId: 'show-other',
    season: 2,
    episode: 3,
    releaseTitle: 'Other Show S02E03 1080p WEB-DL x264',
    indexerName: 'test-indexer',
  });

  const matched = findGrabbedReleaseForEpisode(db, 2, 3);
  expect(matched).not.toBeNull();
  expect(matched!.show_id).toBe('show-other');
  expect(matched!.season_number).toBe(2);
  expect(matched!.episode_number).toBe(3);

  expect(findGrabbedReleaseForEpisode(db, 2, 99)).toBeNull();

  db.close();
});

test('recording does not prune rows below the retention limit', () => {
  const db = new DatabaseManager(':memory:');
  for (let i = 0; i < 5; i++) {
    recordGrabbedRelease(db, {
      showId: `show-${i}`,
      season: 1,
      episode: i + 1,
      releaseTitle: `Show ${i} S01E${i + 1}`,
    });
  }
  const count = db.drizz.select().from(schema.grabbedReleases).all().length;
  expect(count).toBe(5);
  db.close();
});

// ---- listEpisodesDueForGrab (auto-grab selection) ----

const HOUR = 3_600_000;

function seedDueGrabDb() {
  const db = new DatabaseManager(':memory:');
  const now = Date.now();
  const past = new Date(now - 2 * HOUR).toISOString();
  const future = new Date(now + 2 * HOUR).toISOString();

  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Due Show', config: {} });
  db.saveShow({ uuid: 's2', providerId: 'p2', type: 'tmdb', title: 'Movie Show', config: {}, seriesType: 'movie' });

  // Tracked + due -> candidate.
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 1, title: 'E1', airDate: past });
  db.updateEpisodeAirWindow('s1', 1, 1, { expectedReleaseAt: past });
  db.setTracked('s1', 1, 1, true);
  // Tracked but not due yet -> excluded.
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 2, title: 'E2', airDate: future });
  db.updateEpisodeAirWindow('s1', 1, 2, { expectedReleaseAt: future });
  db.setTracked('s1', 1, 2, true);
  // Due but untracked -> excluded.
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 3, title: 'E3', airDate: past });
  db.updateEpisodeAirWindow('s1', 1, 3, { expectedReleaseAt: past });
  db.setTracked('s1', 1, 3, false);
  // Due + tracked but interactive search mode -> excluded (manual-only).
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 4, title: 'E4', airDate: past });
  db.updateEpisodeAirWindow('s1', 1, 4, { expectedReleaseAt: past });
  db.setTracked('s1', 1, 4, true);
  db.updateEpisodeSearchMode('s1', 1, 4, 'interactive');
  // Due + tracked but already on disk -> excluded.
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 5, title: 'E5', airDate: past, filePath: '/media/s1/e5.mkv' });
  db.updateEpisodeAirWindow('s1', 1, 5, { expectedReleaseAt: past });
  db.setTracked('s1', 1, 5, true);
  // Movie show with an episode row (shouldn't happen, but must not grab).
  db.saveEpisode({ showId: 's2', seasonNumber: 1, episodeNumber: 1, title: 'M1', airDate: past });
  db.updateEpisodeAirWindow('s2', 1, 1, { expectedReleaseAt: past });
  db.setTracked('s2', 1, 1, true);
  // Tracked, no expected_release_at yet but air_date has passed -> returned
  // (auto_grabber applies the air_date+delay fallback on the JS side).
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 6, title: 'E6', airDate: new Date(now - 5 * 24 * HOUR).toISOString().slice(0, 10) });
  db.setTracked('s1', 1, 6, true);
  // Tracked, no dates at all -> excluded (nothing to say it's due).
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 7, title: 'E7', airDate: '' });
  db.setTracked('s1', 1, 7, true);
  // Tracked, future air_date, no forecast yet -> excluded (must not search
  // for releases that cannot exist yet).
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 8, title: 'E8', airDate: future });
  db.setTracked('s1', 1, 8, true);

  // s1e1 is tracked/due but has a fresh grab -> cooldown-excluded below.
  return { db, now, past, future };
}

function dueEpisodes(db: DatabaseManager, now: number) {
  return db.listEpisodesDueForGrab(
    new Date(now).toISOString(),
    new Date(now - 12 * HOUR).toISOString(),
    50,
  );
}

test('listEpisodesDueForGrab selects tracked+due+missing, excludes the rest', () => {
  const { db, now } = seedDueGrabDb();
  const rows = dueEpisodes(db, now);
  const eps = rows.filter(r => r.show_id === 's1').map(r => r.episode_number);
  expect(eps).toContain(1);
  expect(eps).toContain(6); // air_date fallback row survives to JS filtering
  expect(eps).not.toContain(2); // not due
  expect(eps).not.toContain(3); // untracked
  expect(eps).not.toContain(4); // interactive mode
  expect(eps).not.toContain(5); // file on disk
  expect(eps).not.toContain(7); // no dates
  expect(eps).not.toContain(8); // future air date, no forecast yet
  expect(rows.find(r => r.show_id === 's2')).toBeUndefined(); // movie
  db.close();
});

test('recent in-flight grabs are held off by the cooldown', () => {
  const { db, now } = seedDueGrabDb();
  recordGrabbedRelease(db, { showId: 's1', season: 1, episode: 1, releaseTitle: 'Due Show S01E01 1080p WEB-DL' });
  let eps = dueEpisodes(db, now).filter(r => r.show_id === 's1').map(r => r.episode_number);
  expect(eps).not.toContain(1); // fresh grab -> skipped

  // Once the grab record is older than the cooldown the episode is
  // re-admitted (download likely failed -> try again, possibly another release).
  db.drizz.update(schema.grabbedReleases)
    .set({ grabbed_at: new Date(now - 13 * HOUR).toISOString() })
    .where(eq(schema.grabbedReleases.show_id, 's1'))
    .run();
  eps = dueEpisodes(db, now).filter(r => r.show_id === 's1').map(r => r.episode_number);
  expect(eps).toContain(1);
  db.close();
});

test('legacy space-separated grabbed_at rows still honor the cooldown', () => {
  const { db, now } = seedDueGrabDb();
  recordGrabbedRelease(db, { showId: 's1', season: 1, episode: 1, releaseTitle: 'Due Show S01E01 1080p WEB-DL' });
  // Simulate a row written before the explicit-ISO fix (datetime('now') default).
  db.drizz.update(schema.grabbedReleases)
    .set({ grabbed_at: new Date(now - HOUR).toISOString().replace('T', ' ').slice(0, 19) })
    .where(eq(schema.grabbedReleases.show_id, 's1'))
    .run();
  const eps = dueEpisodes(db, now).filter(r => r.show_id === 's1').map(r => r.episode_number);
  expect(eps).not.toContain(1);
  db.close();
});
// ---- search backoff ----

const MIN = 60_000;

test('a search miss backs the episode off on a 15m/1h/6h/24h ladder', () => {
  const { db, now } = seedDueGrabDb();
  const due = (at: number) => dueEpisodes(db, at).filter(r => r.show_id === 's1').map(r => r.episode_number);
  const iso = (ms: number) => new Date(ms).toISOString();

  // miss #1 at `now` -> hidden for 15m
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(now));
  expect(due(now + 14 * MIN)).not.toContain(6);
  expect(due(now + 16 * MIN)).toContain(6);
  expect(due(now + 1 * MIN)).toContain(1); // other eps unaffected

  // miss #2 -> 1h
  const t2 = now + 16 * MIN;
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(t2));
  expect(due(t2 + 59 * MIN)).not.toContain(6);
  expect(due(t2 + 61 * MIN)).toContain(6);

  // miss #3 -> 6h, miss #4+ -> capped at 24h
  const t3 = t2 + 61 * MIN;
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(t3));
  expect(due(t3 + 5 * 60 * MIN)).not.toContain(6);
  expect(due(t3 + 6 * 60 * MIN + MIN)).toContain(6);
  const t4 = t3 + 6 * 60 * MIN + MIN;
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(t4));
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(t4));
  expect(due(t4 + 23 * 60 * MIN)).not.toContain(6);
  expect(due(t4 + 24 * 60 * MIN + MIN)).toContain(6);
  db.close();
});

test('never-searched episodes are ordered before backed-off ones, oldest search first', () => {
  const { db, now } = seedDueGrabDb();
  const iso = (ms: number) => new Date(ms).toISOString();
  // Both 1 and 6 searched long ago (past their backoff); 6 searched earlier.
  db.recordEpisodeSearchMiss('s1', 1, 1, iso(now - 2 * HOUR));
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(now - 3 * HOUR));
  // A fresh never-searched episode.
  db.saveEpisode({ showId: 's1', seasonNumber: 1, episodeNumber: 9, title: 'E9', airDate: new Date(now - 10 * 24 * HOUR).toISOString().slice(0, 10) });
  db.setTracked('s1', 1, 9, true);
  const order = dueEpisodes(db, now).filter(r => r.show_id === 's1').map(r => r.episode_number);
  expect(order).toEqual([9, 6, 1]);
  db.close();
});

test('a grab or a moved release window clears the backoff', () => {
  const { db, now } = seedDueGrabDb();
  const iso = (ms: number) => new Date(ms).toISOString();
  db.recordEpisodeSearchMiss('s1', 1, 6, iso(now));
  expect(dueEpisodes(db, now + MIN).map(r => r.episode_number)).not.toContain(6);

  // Release window moved later than the last search (air date corrected).
  db.updateEpisodeAirWindow('s1', 1, 6, { expectedReleaseAt: iso(now + 30_000) });
  expect(dueEpisodes(db, now + MIN).map(r => r.episode_number)).toContain(6);

  // Grab resets the counters entirely.
  db.recordEpisodeSearchMiss('s1', 1, 1, iso(now));
  recordGrabbedRelease(db, { showId: 's1', season: 1, episode: 1, releaseTitle: 'Due Show S01E01 1080p WEB-DL' });
  const row = db.db.query('SELECT last_searched_at, search_attempts FROM episodes WHERE show_id = ? AND season_number = 1 AND episode_number = 1').get('s1') as any;
  expect(row.last_searched_at).toBeNull();
  expect(row.search_attempts).toBe(0);
  db.close();
});
