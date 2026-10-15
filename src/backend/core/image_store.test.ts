import { test, expect } from 'bun:test';
import { existsSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseManager } from '../db';
import { runImageMigration, countPendingArtworkBlobs, sweepOrphanImages } from './image_migration';
import { absImagePath, hashImage } from './image_store';

function newDb() {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Show One', config: {} });
  db.saveShow({ uuid: 's2', providerId: 'p2', type: 'tmdb', title: 'Show Two', config: {} });
  return db;
}

const bytes = (n: number) => new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * n) % 251));

test('saveShowArtwork writes a content-addressed file, not a blob', () => {
  const db = newDb();
  const data = bytes(3);
  db.saveShowArtwork('s1', 2, 'https://x/p.jpg', undefined, undefined, undefined, data, 'image/jpeg');
  const [row] = db.getShowArtworkMeta('s1', 2);
  expect(row!.image_hash).toBe(hashImage(data));
  expect(row!.image_path).toBe(`${row!.image_hash!.slice(0, 2)}/${row!.image_hash}.jpg`);
  expect(row!.data_len).toBe(64);
  expect(existsSync(join(db.imagesDir, row!.image_path!))).toBe(true);
  const raw = db.db.query('SELECT data FROM show_artworks WHERE id = ?').get(row!.id) as { data: unknown };
  expect(raw.data).toBeNull();
  expect(Array.from(db.getShowArtworkBlob(row!.id)!)).toEqual(Array.from(data));
});

test('replacing an image removes the old file; shared files survive until unreferenced', () => {
  const db = newDb();
  const shared = bytes(5);
  db.saveShowArtwork('s1', 2, 'u1', undefined, undefined, undefined, shared, 'image/jpeg');
  db.saveShowArtwork('s2', 2, 'u1', undefined, undefined, undefined, shared, 'image/jpeg');
  const p = db.getShowArtworkMeta('s1', 2)[0]!.image_path!;
  expect(db.getShowArtworkMeta('s2', 2)[0]!.image_path).toBe(p);

  db.saveShowArtwork('s1', 2, 'u2', undefined, undefined, undefined, bytes(7), 'image/jpeg');
  expect(existsSync(join(db.imagesDir, p))).toBe(true); // s2 still uses it

  db.removeShow('s2');
  expect(existsSync(join(db.imagesDir, p))).toBe(false);

  const p2 = db.getShowArtworkMeta('s1', 2)[0]!.image_path!;
  db.removeShows(['s1']);
  expect(existsSync(join(db.imagesDir, p2))).toBe(false);
});

test('background migration moves legacy blobs in batches, resumable, then nulls them', async () => {
  const db = newDb();
  // legacy rows: blob in the DB, no file
  for (const [i, show] of [[1, 's1'], [2, 's2']] as const) {
    db.db.run(
      'INSERT INTO show_artworks (show_id, provider_type, artwork_type, image_url, content_type, data) VALUES (?, ?, ?, ?, ?, ?)',
      [show, 'tmdb', String(i === 1 ? 2 : 15), `u${i}`, 'image/png', bytes(i + 10)],
    );
  }
  expect(countPendingArtworkBlobs(db)).toBe(2);
  // legacy blob still served before migration
  const legacy = db.getShowArtworkMeta('s1', 2)[0]!;
  expect(legacy.data_len).toBe(64);
  expect(legacy.image_path).toBeNull();
  expect(db.getShowArtworkBlob(legacy.id)!.byteLength).toBe(64);

  // one batch of one row, then "restart"
  const first = await runImageMigration(db, { batchSize: 1, pauseMs: 0, maxBatches: 1 });
  expect(first.moved).toBe(1);
  expect(countPendingArtworkBlobs(db)).toBe(1);
  const second = await runImageMigration(db, { batchSize: 1, pauseMs: 0 });
  expect(second.moved).toBe(1);
  expect(countPendingArtworkBlobs(db)).toBe(0);

  const moved = db.getShowArtworkMeta('s1', 2)[0]!;
  expect(moved.image_path).not.toBeNull();
  expect(Array.from(db.getShowArtworkBlob(moved.id)!)).toEqual(Array.from(bytes(11)));
});

test('missing file falls back to the legacy blob when there is one', () => {
  const db = newDb();
  db.saveShowArtwork('s1', 2, 'u', undefined, undefined, undefined, bytes(2), 'image/jpeg');
  const row = db.getShowArtworkMeta('s1', 2)[0]!;
  db.db.run('UPDATE show_artworks SET data = ? WHERE id = ?', [bytes(2), row.id]);
  unlinkSync(join(db.imagesDir, row.image_path!));
  expect(db.getShowArtworkBlob(row.id)!.byteLength).toBe(64);
  db.clearShowArtworkImage(row.id);
  expect(db.getShowArtworkMeta('s1', 2)[0]!.image_path).toBeNull();
});

test('orphan sweep removes unreferenced old files and leaves referenced / fresh ones', () => {
  const db = newDb();
  db.saveShowArtwork('s1', 2, 'u', undefined, undefined, undefined, bytes(4), 'image/jpeg');
  const kept = db.getShowArtworkMeta('s1', 2)[0]!.image_path!;
  const orphanRel = `ab/${'ab'.padEnd(40, '0')}.jpg`;
  const freshRel = `cd/${'cd'.padEnd(40, '0')}.jpg`;
  for (const rel of [orphanRel, freshRel]) {
    mkdirSync(join(db.imagesDir, rel.slice(0, 2)), { recursive: true });
    writeFileSync(join(db.imagesDir, rel), 'x');
  }
  const old = (Date.now() - 2 * 3600_000) / 1000;
  utimesSync(join(db.imagesDir, orphanRel), old, old);
  utimesSync(join(db.imagesDir, kept), old, old);
  expect(sweepOrphanImages(db)).toBe(1);
  expect(existsSync(join(db.imagesDir, orphanRel))).toBe(false);
  expect(existsSync(join(db.imagesDir, freshRel))).toBe(true);
  expect(existsSync(join(db.imagesDir, kept))).toBe(true);
});

test('absImagePath refuses anything that is not one of our hash paths', () => {
  expect(absImagePath('/d', '../etc/passwd')).toBeNull();
  expect(absImagePath('/d', 'ab/../../x.jpg')).toBeNull();
  expect(absImagePath('/d', `ab/${'a'.repeat(40)}.jpg`)).toBe(`/d/ab/${'a'.repeat(40)}.jpg`);
});
