import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, utimesSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  selectRetained, normalizeRetention, loadRetention, pruneBackups, isoWeekKey,
  snapshotBackupImages, restoreBackupImages, pruneBackupImages, DEFAULT_RETENTION,
} from './backup';
import { writeImage } from './image_store';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T03:00:00Z');

test('7 daily + 4 weekly + 2 recent out of 60 daily backups', () => {
  const units = Array.from({ length: 60 }, (_, i) => ({ key: `b${i}`, mtime: NOW - i * DAY }));
  const kept = selectRetained(units, { recent: 2, daily: 7, weekly: 4 });
  const keys = [...kept.keys()];
  // 7 dailies cover days 0..6 (recent 0,1 inside them); weekly adds the
  // newest of each of the 4 newest ISO weeks not already kept.
  for (let i = 0; i < 7; i++) expect(kept.has(`b${i}`)).toBe(true);
  expect(kept.get('b0')).toBe('recent');
  expect(kept.get('b2')).toBe('daily');
  const weeks = new Set(keys.map((k) => isoWeekKey(NOW - Number(k.slice(1)) * DAY)));
  expect(weeks.size).toBeGreaterThanOrEqual(4);
  expect(keys.length).toBeLessThanOrEqual(2 + 7 + 4);
  expect(kept.has('b59')).toBe(false);
});

test('several backups the same day: newest per day is the daily slot', () => {
  const units = [
    { key: 'a', mtime: NOW },
    { key: 'b', mtime: NOW - 60_000 },
    { key: 'c', mtime: NOW - 120_000 },
    { key: 'd', mtime: NOW - DAY },
  ];
  const kept = selectRetained(units, { recent: 1, daily: 2, weekly: 0 });
  expect([...kept.keys()].sort()).toEqual(['a', 'd']);
});

test('normalizeRetention clamps and never keeps zero', () => {
  expect(normalizeRetention({ recent: 0, daily: 0, weekly: 0 })).toEqual({ recent: 1, daily: 0, weekly: 0 });
  expect(normalizeRetention({ recent: '500', daily: -3, weekly: 'x' })).toEqual({ recent: 100, daily: 0, weekly: DEFAULT_RETENTION.weekly });
  expect(normalizeRetention(null)).toEqual(DEFAULT_RETENTION);
});

test('legacy keepCount becomes keepRecent, new keys win', () => {
  const legacyOnly = loadRetention((k) => (k === 'backup.keepCount' ? '25' : null));
  expect(legacyOnly).toEqual({ recent: 25, daily: 7, weekly: 4 });
  const both = loadRetention((k) => ({ 'backup.keepCount': '25', 'backup.keepRecent': '3', 'backup.keepDaily': '5' } as Record<string, string>)[k] ?? null);
  expect(both).toEqual({ recent: 3, daily: 5, weekly: 4 });
});

// Fixture DBs: one transaction, no journal file, no fsync. The default
// (rollback journal + synchronous=FULL, one autocommit per statement) cost ~3
// fsyncs per statement, ~60 for the 10-backup test below; on the NAS runner
// (docker-in-docker overlayfs on spinning disks) that alone took ~10s.
// Durability means nothing for a throwaway temp file.
function makeBackupDb(path: string, imagePaths: string[]) {
  const d = new Database(path);
  d.run('PRAGMA journal_mode = OFF');
  d.run('PRAGMA synchronous = OFF');
  d.transaction(() => {
    d.run('CREATE TABLE show_artworks (id INTEGER PRIMARY KEY, image_path TEXT)');
    for (const p of imagePaths) d.run('INSERT INTO show_artworks (image_path) VALUES (?)', [p]);
  })();
  d.close();
}

test('pruneBackups applies the policy on disk and drops unreferenced image-store files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-bk-'));
  const live = mkdtempSync(join(tmpdir(), 'sf-img-'));
  const a = writeImage(live, new Uint8Array([1, 2, 3]), 'image/jpeg');
  const b = writeImage(live, new Uint8Array([4, 5, 6]), 'image/png');

  // 10 daily backups; the oldest one alone references image b
  for (let i = 0; i < 10; i++) {
    const f = join(dir, `showflow-${i}.db`);
    makeBackupDb(f, i === 9 ? [b.path] : [a.path]);
    writeFileSync(join(dir, `showflow-${i}.sql`), '--');
    snapshotBackupImages(f, dir, live);
    const t = (NOW - i * DAY) / 1000;
    utimesSync(f, t, t);
    utimesSync(join(dir, `showflow-${i}.sql`), t, t);
  }
  expect(existsSync(join(dir, 'images', b.path))).toBe(true);

  const deleted = await pruneBackups(dir, { recent: 1, daily: 3, weekly: 0 });
  const left = readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
  expect(left).toEqual(['showflow-0.db', 'showflow-1.db', 'showflow-2.db']);
  expect(deleted.length).toBe(14); // 7 units x (.db + .sql)
  expect(existsSync(join(dir, 'images', a.path))).toBe(true);
  expect(existsSync(join(dir, 'images', b.path))).toBe(false);
  expect(await pruneBackupImages(dir)).toBe(0);
}, 20_000); // ~25ms locally; headroom for slow runner disks (it's ~40 small file ops even without fsync)

test('legacy numeric keepCount still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-bk-'));
  for (let i = 0; i < 5; i++) {
    const f = join(dir, `x${i}.db`);
    writeFileSync(f, '');
    const t = (NOW - i * 3600_000) / 1000;
    utimesSync(f, t, t);
  }
  await pruneBackups(dir, 2);
  expect(readdirSync(dir).sort()).toEqual(['x0.db', 'x1.db']);
});

test('restoreBackupImages puts back files the restored DB references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-bk-'));
  const live = mkdtempSync(join(tmpdir(), 'sf-img-'));
  const img = writeImage(live, new Uint8Array([9, 9, 9]), 'image/jpeg');
  const f = join(dir, 'showflow-r.db');
  makeBackupDb(f, [img.path]);
  expect(snapshotBackupImages(f, dir, live)).toEqual({ linked: 1, missing: 0 });

  const fresh = mkdtempSync(join(tmpdir(), 'sf-img-'));
  mkdirSync(fresh, { recursive: true });
  expect(restoreBackupImages(f, dir, fresh)).toBe(1);
  expect(existsSync(join(fresh, img.path))).toBe(true);
});
