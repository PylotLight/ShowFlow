import { test, expect, mock } from 'bun:test';
import * as realDb from '../../db';
import { DatabaseManager } from '../../db';

/**
 * Import resolution used to strip "(2026)" and then exact-match the bare
 * "Scrubs", which always picked the 2001 series. The revival's episodes
 * therefore never got a file, so auto-grab re-downloaded them forever.
 *
 * The oracle is wired to the global `db`, so swap it for an in-memory
 * database before loading the class.
 */
const mem = new DatabaseManager(':memory:');
mem.saveShow({
  uuid: 'classic',
  providerId: '76156',
  type: 'tvdb',
  title: 'Scrubs',
  year: 2001,
  config: {},
});
mem.saveShow({
  uuid: 'revival',
  providerId: '465690',
  type: 'tvdb',
  title: 'Scrubs (2026)',
  year: 2026,
  config: {},
  metadata: { aliases: ['Scrubs'] },
});
mem.syncAllShowTitles('revival', 'tvdb', {
  title: 'Scrubs (2026)',
  aliases: ['Scrubs'],
});

mock.module('../../db', () => ({ ...realDb, db: mem }));

const { Oracle } = await import('../oracle');

test('parenthesized year picks the matching same-titled show', () => {
  const oracle = new Oracle();
  const find = (title: string, year?: number) =>
    (oracle as unknown as {
      findLocalShow: (title: string, year?: number) => { localShowId: string } | null;
    }).findLocalShow(title, year);

  expect(find('Scrubs', 2001)?.localShowId).toBe('classic');
  expect(find('Scrubs', 2026)?.localShowId).toBe('revival');
  // No year keeps the old tie-break (the original series).
  expect(find('Scrubs')?.localShowId).toBe('classic');
  // A year that matches neither local show falls back instead of failing.
  expect(find('Scrubs', 1999)?.localShowId).toBe('classic');
});
