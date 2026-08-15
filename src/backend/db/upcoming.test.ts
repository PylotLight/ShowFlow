import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';

function seed(db: DatabaseManager) {
  db.saveShow({ uuid: 'monitored', providerId: 'p1', type: 'tmdb', title: 'Monitored Show', config: {} });
  db.saveShow({ uuid: 'unmonitored', providerId: 'p2', type: 'tmdb', title: 'Unmonitored Show', config: {} });

  const near = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  db.saveEpisode({ showId: 'monitored', seasonNumber: 1, episodeNumber: 1, title: 'E1', airDate: near });
  db.saveEpisode({ showId: 'monitored', seasonNumber: 1, episodeNumber: 2, title: 'E2', airDate: near });
  db.saveEpisode({ showId: 'unmonitored', seasonNumber: 1, episodeNumber: 1, title: 'U1', airDate: near });

  // Monitored show: track both episodes. Unmonitored show: leave untracked.
  db.setTracked('monitored', 1, 1, true);
  db.setTracked('monitored', 1, 2, true);
}

test('listUpcomingEpisodes only returns episodes from monitored shows', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  const upcoming = db.listUpcomingEpisodes(7);
  expect(upcoming.length).toBe(2);
  expect(upcoming.every(e => e.show_id === 'monitored')).toBe(true);

  db.close();
});

test('listUpcomingEpisodes excludes individually untracked episodes', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  db.setTracked('monitored', 1, 2, false);
  const upcoming = db.listUpcomingEpisodes(7);
  expect(upcoming.length).toBe(1);
  expect(upcoming[0]!.episode_number).toBe(1);

  db.close();
});
