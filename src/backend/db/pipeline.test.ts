import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';

function seed(db: DatabaseManager) {
  db.saveShow({ uuid: 'show1', providerId: 'p1', type: 'tmdb', title: 'Show One', config: {} });
  const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  db.saveEpisode({ showId: 'show1', seasonNumber: 1, episodeNumber: 1, title: 'Aired', airDate: past });
  db.saveEpisode({ showId: 'show1', seasonNumber: 1, episodeNumber: 2, title: 'TBA', airDate: '' });
  db.saveEpisode({ showId: 'show1', seasonNumber: 1, episodeNumber: 3, title: 'TBA but forecast', airDate: '' });
  db.saveEpisode({ showId: 'show1', seasonNumber: 2, episodeNumber: 1, title: 'Next season, all TBA' });

  for (const [s, e] of [[1, 1], [1, 2], [1, 3], [2, 1]]) {
    db.setTracked('show1', s, e, true);
  }
  db.updateEpisodeAirWindow('show1', 1, 3, { expectedReleaseAt: new Date(Date.now() - 60_000).toISOString() });
}

test('dateless TBA episodes do not surface as WANTED', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  const eps = db.listKanbanEpisodes();
  const nums = eps.map(e => `${e.seasonNumber}x${e.episodeNumber}`);

  expect(nums).toContain('1x1');
  expect(nums).not.toContain('1x2');
  expect(nums).not.toContain('2x1');
  const wantedNoDate = eps.filter(e => e.currentStage === 'WANTED' && e.airDate === null);
  expect(wantedNoDate.map(e => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['1x3']);

  db.close();
});

test('TBA episode with a release forecast still counts as WANTED', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  const forecast = db.listKanbanEpisodes().find(e => e.episodeNumber === 3 && e.seasonNumber === 1);
  expect(forecast?.currentStage).toBe('WANTED');

  db.close();
});
