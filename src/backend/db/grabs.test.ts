import { test, expect } from 'bun:test';
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