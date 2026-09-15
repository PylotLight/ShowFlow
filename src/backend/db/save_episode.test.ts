import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';

test('saveEpisode preserves air date/time across file-only import writes', () => {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Show', config: {} });

  // Metadata sync first: full info including air date/time.
  db.saveEpisode({
    showId: 's1', seasonNumber: 4, episodeNumber: 7,
    title: 'Vote for Sampson', airDate: '2026-08-12T17:45:00.000Z', airTime: '17:45',
  });

  // Import path (blackhole): only file info, no dates — must not wipe them.
  db.saveEpisode({
    showId: 's1', seasonNumber: 4, episodeNumber: 7,
    title: 'Vote for Sampson', filePath: '/Data/Media/Shows/Reacher/Season 4/x.mkv',
  });

  const ep = db.getEpisode('s1', 4, 7) as any;
  expect(ep.air_date).toBe('2026-08-12T17:45:00.000Z');
  expect(ep.air_time).toBe('17:45');
  expect(ep.file_path).toBe('/Data/Media/Shows/Reacher/Season 4/x.mkv');

  // Explicit new values still overwrite.
  db.saveEpisode({
    showId: 's1', seasonNumber: 4, episodeNumber: 7, airDate: '2026-08-19T17:45:00.000Z',
  });
  expect((db.getEpisode('s1', 4, 7) as any).air_date).toBe('2026-08-19T17:45:00.000Z');

  db.close();
});
