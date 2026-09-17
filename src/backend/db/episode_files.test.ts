import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';
import * as schema from './schema';
import { pruneSupersededEpisodeFiles } from './episode_files';

function seed(db: DatabaseManager) {
  db.saveShow({ uuid: 'show-1', providerId: 'p1', type: 'tmdb', title: 'Show', config: {} });
  db.saveEpisode({ showId: 'show-1', seasonNumber: 1, episodeNumber: 1, title: 'E1' });
  db.saveEpisode({ showId: 'show-1', seasonNumber: 1, episodeNumber: 2, title: 'E2' });
}

function record(db: DatabaseManager, filePath: string) {
  db.recordEpisodeFile({
    showId: 'show-1',
    season: 1,
    episode: 1,
    filePath,
    sourceKind: 'import',
  });
}

test('pruneSupersededEpisodeFiles keeps live row + latest superseded per episode', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  // Simulate 4 successive scans/upgrades of the same episode, plus an
  // untouched episode that must survive intact.
  record(db, '/a/s01e01-v1.mkv');
  record(db, '/a/s01e01-v2.mkv');
  record(db, '/a/s01e01-v3.mkv');
  record(db, '/a/s01e01-v4.mkv');
  db.recordEpisodeFile({
    showId: 'show-1', season: 1, episode: 2,
    filePath: '/a/s01e02.mkv', sourceKind: 'import',
  });

  const pruned = pruneSupersededEpisodeFiles(db);
  expect(pruned).toBe(2);

  const rows = db.drizz.select().from(schema.episodeFiles).all();
  expect(rows).toHaveLength(3);
  const ep1 = rows.filter(r => r.episode_number === 1).sort((a, b) => a.id - b.id);
  expect(ep1.map(r => r.is_current)).toEqual([0, 1]);
  expect(ep1[1]!.file_path).toBe('/a/s01e01-v4.mkv');
  // Latest superseded row is last-upgrade history, not bloat.
  expect(ep1[0]!.file_path).toBe('/a/s01e01-v3.mkv');

  db.close();
});

test('pruneSupersededEpisodeFiles is a no-op on a clean table', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);
  record(db, '/a/s01e01.mkv');
  expect(pruneSupersededEpisodeFiles(db)).toBe(0);
  db.close();
});
