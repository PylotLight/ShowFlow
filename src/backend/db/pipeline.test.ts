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

test('listHistory merges grabs, imports, and pipeline events', () => {
  const db = new DatabaseManager(':memory:');
  seed(db);

  db.logPipelineEvent({
    showId: 'show1', seasonNumber: 1, episodeNumber: 1,
    stage: 'SEARCHING', eventType: 'search_completed',
    message: 'Queried 3 indexer(s), found 10 release(s)',
  });
  db.recordGrabbedRelease({
    showId: 'show1', season: 1, episode: 1,
    releaseTitle: 'Show One S01E01 1080p WEB-DL',
    indexerName: 'test-indexer',
  });
  db.recordEpisodeFile({
    showId: 'show1', season: 1, episode: 1,
    filePath: '/media/Show One/Season 1/Show One - S01E01.mkv',
    originalName: 'Show.One.S01E01.1080p.WEB-DL.mkv',
  });

  const { items, hasMore } = db.listHistory({ limit: 50 });
  expect(hasMore).toBe(false);
  const kinds = items.map(i => i.kind);
  expect(kinds).toContain('grab');
  expect(kinds).toContain('import');
  expect(kinds).toContain('event');
  expect(items.every(i => i.showTitle === 'Show One')).toBe(true);

  // Kind filter narrows to one source.
  const grabs = db.listHistory({ kind: 'grab' });
  expect(grabs.items.length).toBe(1);
  expect(grabs.items[0]!.releaseTitle).toBe('Show One S01E01 1080p WEB-DL');

  // Free-text query matches release titles.
  const searched = db.listHistory({ query: 'WEB-DL' });
  expect(searched.items.length).toBeGreaterThanOrEqual(2);

  // Pagination reports more pages.
  const first = db.listHistory({ limit: 1 });
  expect(first.items.length).toBe(1);
  expect(first.hasMore).toBe(true);
  const second = db.listHistory({ limit: 1, offset: 1 });
  expect(second.items.length).toBe(1);
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

  db.close();
});
