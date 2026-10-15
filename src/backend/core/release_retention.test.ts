import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldReleases } from './release_retention';

async function makeRelease(root: string, sub: string, id: string, ageMin: number) {
  const dir = join(root, sub, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'showflow'), 'x'.repeat(1000));
  const t = new Date(Date.now() - ageMin * 60_000);
  await utimes(dir, t, t);
}

test('prunes old release + download dirs, keeps live/protected/recent ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-ret-'));
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(root, 'state', 'active.json'), JSON.stringify({ active: 'r-active', lastKnownGood: 'r-lkg' }));
  // ages in minutes: higher = older
  for (const [id, age] of [['r-active', 500], ['r-lkg', 400], ['r-old1', 300], ['r-old2', 200], ['r-new1', 30], ['r-new2', 20], ['r-pending', 900]] as const) {
    await makeRelease(root, 'releases', id, age);
    await makeRelease(root, 'downloads', id, age);
  }
  const res = await pruneOldReleases({ dataDir: root, keepRecent: 2, protectIds: ['r-pending'] });
  const left = (await readdir(join(root, 'releases'))).sort();
  expect(left).toEqual(['r-active', 'r-lkg', 'r-new1', 'r-new2', 'r-pending']);
  expect((await readdir(join(root, 'downloads'))).sort()).toEqual(left);
  expect(res.deleted.sort()).toEqual(['downloads/r-old1', 'downloads/r-old2', 'releases/r-old1', 'releases/r-old2']);
  expect(res.freedBytes).toBe(4000);
});

test('no supervisor state file -> no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-ret-'));
  await makeRelease(root, 'releases', 'r1', 100);
  await makeRelease(root, 'releases', 'r2', 50);
  const res = await pruneOldReleases({ dataDir: root, keepRecent: 1 });
  expect(res.deleted).toEqual([]);
  expect((await readdir(join(root, 'releases'))).length).toBe(2);
});
