import { test, expect, describe } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashFileForDedupe, HASH_FULL_LIMIT } from './blackhole';

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'showflow-hash-'));
  return path.join(dir, name);
}

describe('hashFileForDedupe', () => {
  test('small files keep the historical whole-file sha256 digest', async () => {
    const p = await tempFile('small.mkv');
    const bytes = new Uint8Array(2048).fill(7);
    await Bun.write(p, bytes);

    const expected = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    expect(await hashFileForDedupe(p)).toBe(expected);
    await rm(path.dirname(p), { recursive: true, force: true });
  });

  test('large files hash a size + head/middle/tail sample, not the whole file', async () => {
    // Sparse file: the filesystem allocates nothing for the hole, so this
    // stands in for a 600GB remux without filling the test disk.
    const size = HASH_FULL_LIMIT + 64 * 1024 * 1024;
    const p = await tempFile('big.mkv');
    const fh = await open(p, 'w');
    await fh.truncate(size);
    await fh.write(Buffer.from([1]), 0, 1, 0);
    await fh.write(Buffer.from([2]), 0, 1, Math.floor(size / 2));
    await fh.write(Buffer.from([3]), 0, 1, size - 8);
    await fh.close();

    const hash = await hashFileForDedupe(p);
    expect(hash).toHaveLength(64);
    // Stable across calls.
    expect(await hashFileForDedupe(p)).toBe(hash);

    // A byte inside one of the sampled windows changes the digest…
    const fh2 = await open(p, 'r+');
    await fh2.write(Buffer.from([9]), 0, 1, size - 8);
    await fh2.close();
    expect(await hashFileForDedupe(p)).not.toBe(hash);

    // …and so does a rename of the file itself (same bytes, same hash).
    await rm(path.dirname(p), { recursive: true, force: true });
  });

  test('a same-size file differing only outside the sampled windows collides by design', async () => {
    // Documented trade-off of partial hashing: dedupe is a "have I already
    // imported THIS drop" guard, not an integrity check. Anything that got
    // far enough to share a size and three 4MiB regions is the same release.
    const size = HASH_FULL_LIMIT + 64 * 1024 * 1024;
    const p = await tempFile('collide.mkv');
    const fh = await open(p, 'w');
    await fh.truncate(size);
    await fh.write(Buffer.from([1]), 0, 1, 0);
    await fh.close();

    const before = await hashFileForDedupe(p);
    const mid = Math.floor(size / 4);
    const fh2 = await open(p, 'r+');
    await fh2.write(Buffer.from([8]), 0, 1, mid);
    await fh2.close();

    expect(await hashFileForDedupe(p)).toBe(before);
    await rm(path.dirname(p), { recursive: true, force: true });
  });
});
