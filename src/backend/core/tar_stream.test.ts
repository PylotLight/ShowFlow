import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTarExtractor, createTarGzExtractor, safeJoin } from './tar_stream';

const root = await mkdtemp(join(tmpdir(), 'sf-tar-'));
afterAll(() => rm(root, { recursive: true, force: true }));

function tarOf(srcDir: string, args: string[], gz = false): Uint8Array {
  const out = join(root, `t-${Math.random().toString(36).slice(2)}.tar${gz ? '.gz' : ''}`);
  const p = Bun.spawnSync(['tar', gz ? '-czf' : '-cf', out, '-C', srcDir, ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return new Uint8Array(require('node:fs').readFileSync(out));
}

async function feed(ex: { write(c: Uint8Array): Promise<void> }, data: Uint8Array, step: number) {
  for (let i = 0; i < data.byteLength; i += step) await ex.write(data.subarray(i, i + step));
}

test('extracts files, dirs and long names identically to tar, at any chunk size', async () => {
  const src = join(root, 'src1');
  const longDir = 'migrations/' + 'd'.repeat(80);
  await mkdir(join(src, longDir), { recursive: true });
  const big = new Uint8Array(70_001).map((_, i) => i % 253);
  await Bun.write(join(src, 'showflow'), big);
  await Bun.write(join(src, 'manifest.json'), '{"a":1}');
  await Bun.write(join(src, longDir, 'x'.repeat(60) + '.sql'), 'select 1;');
  await Bun.write(join(src, 'empty'), '');
  const tar = tarOf(src, ['showflow', 'manifest.json', 'migrations', 'empty']);
  for (const step of [1, 511, 512, 4096, 1 << 20]) {
    const dest = join(root, `out-${step}`);
    const ex = createTarExtractor(dest, { hashFiles: ['showflow'] });
    await feed(ex, tar, step);
    const entries = await ex.end();
    expect(new Uint8Array(await Bun.file(join(dest, 'showflow')).arrayBuffer())).toEqual(big);
    expect(await Bun.file(join(dest, longDir, 'x'.repeat(60) + '.sql')).text()).toBe('select 1;');
    expect(await Bun.file(join(dest, 'empty')).text()).toBe('');
    expect(entries.find((e) => e.path === 'showflow')?.sha256).toBe(new Bun.CryptoHasher('sha256').update(big).digest('hex'));
  }
});

test('gzip variant streams through DecompressionStream', async () => {
  const src = join(root, 'src2');
  await mkdir(src, { recursive: true });
  await Bun.write(join(src, 'a.txt'), 'hello');
  const tgz = tarOf(src, ['a.txt'], true);
  const dest = join(root, 'out-gz');
  const ex = createTarGzExtractor(dest);
  await feed(ex, tgz, 13);
  await ex.end();
  expect(await Bun.file(join(dest, 'a.txt')).text()).toBe('hello');
});

test('truncated archives and corrupt gzip fail loudly', async () => {
  const src = join(root, 'src3');
  await mkdir(src, { recursive: true });
  await Bun.write(join(src, 'f'), new Uint8Array(5000).fill(1));
  const tar = tarOf(src, ['f']);
  const ex = createTarExtractor(join(root, 'out-trunc'));
  await ex.write(tar.subarray(0, 2000));
  await expect(ex.end()).rejects.toThrow(/truncated/);

  const gz = createTarGzExtractor(join(root, 'out-bad'));
  let threw = false;
  try {
    await gz.write(new Uint8Array(4096).fill(7));
    await gz.end();
  } catch { threw = true; }
  expect(threw).toBe(true);
});

test('rejects paths escaping the destination', async () => {
  expect(safeJoin('/data/x', '../etc/passwd')).toBeNull();
  expect(safeJoin('/data/x', '/etc/passwd')).toBeNull();
  expect(safeJoin('/data/x', 'a/../../b')).toBeNull();
  expect(safeJoin('/data/x', './showflow')).toBe('/data/x/showflow');

  // Hand-craft a header named ../evil
  const block = new Uint8Array(1024);
  const enc = new TextEncoder();
  block.set(enc.encode('../evil'), 0);
  block.set(enc.encode('0000644\0'), 100);
  block.set(enc.encode('00000000000\0'), 124);
  block[156] = '0'.charCodeAt(0);
  block.set(enc.encode('ustar\0'), 257);
  block.set(enc.encode('00'), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  block.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  const ex = createTarExtractor(join(root, 'out-evil'));
  await expect(ex.write(block)).rejects.toThrow(/unsafe path/);
});
