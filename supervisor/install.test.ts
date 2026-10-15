import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'sf-sup-'));
const prev = process.env.SHOWFLOW_DATA_DIR;
process.env.SHOWFLOW_DATA_DIR = dataDir;
afterAll(async () => {
  if (prev === undefined) delete process.env.SHOWFLOW_DATA_DIR; else process.env.SHOWFLOW_DATA_DIR = prev;
  await rm(dataDir, { recursive: true, force: true });
});

async function stageDownload(id: string, body: string) {
  const src = join(dataDir, 'downloads', id);
  await mkdir(join(src, 'migrations'), { recursive: true });
  await Bun.write(join(src, 'showflow'), body);
  await Bun.write(join(src, 'migrations', '0000.sql'), 'select 1;');
  const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  await Bun.write(join(src, 'manifest.json'), JSON.stringify({ releaseId: id, version: 'v1.0.0', commit: id, platform: 'linux-x64', readyPath: '/internal/ready', artifact: { name: 'showflow', sha256 }, minimumSupervisorVersion: '0.1.0' }));
}

test('refuses to install over the active release', async () => {
  const { installRelease } = await import('./install');
  await stageDownload('live', 'x');
  const r = await installRelease('live', 'live');
  expect(r.ok).toBe(false);
  expect(r.message).toContain('active release');
});

test('reinstall swaps the dir via rename: the old binary inode is never written', async () => {
  const { installRelease } = await import('./install');
  await stageDownload('rel1', 'first');
  expect((await installRelease('rel1', 'other')).ok).toBe(true);
  const bin = join(dataDir, 'releases', 'rel1', 'showflow');
  const inodeBefore = (await stat(bin)).ino;
  await stageDownload('rel1', 'second');
  expect((await installRelease('rel1', 'other')).ok).toBe(true);
  expect(await Bun.file(bin).text()).toBe('second');
  expect((await stat(bin)).ino).not.toBe(inodeBefore); // new file, not an in-place write
  // no tmp/old leftovers
  expect((await readdir(join(dataDir, 'releases'))).sort()).toEqual(['rel1']);
  expect(await readdir(join(dataDir, 'releases', 'rel1', 'migrations'))).toEqual(['0000.sql']);
});

test('install verifies the copy once and activate reuses it (no second hash); a bad sha installs nothing', async () => {
  const { installRelease } = await import('./install');
  const { verifyArtifact, readManifest, releasePath } = await import('./state');
  await stageDownload('fast1', 'payload-bytes');
  expect((await installRelease('fast1', null)).ok).toBe(true);
  const dir = releasePath('fast1');
  const m = (await readManifest(dir))!;
  // Swap the hasher out: a cached verify must not hash at all.
  const Real = Bun.CryptoHasher;
  let hashed = 0;
  (Bun as any).CryptoHasher = class extends Real { constructor(a: any) { super(a); hashed++; } };
  try {
    expect(await verifyArtifact(dir, m)).toBe(true);
    expect(hashed).toBe(0);
  } finally {
    (Bun as any).CryptoHasher = Real;
  }

  await stageDownload('fast2', 'good');
  const src = join(dataDir, 'downloads', 'fast2');
  await Bun.write(join(src, 'showflow'), 'tampered'); // manifest still says sha('good')
  const r = await installRelease('fast2', null);
  expect(r.ok).toBe(false);
  expect(r.message).toContain('checksum mismatch');
  expect(await Bun.file(join(releasePath('fast2'), 'showflow')).exists()).toBe(false);
  expect((await readdir(join(dataDir, 'releases'))).some((n) => n.startsWith('fast2.tmp'))).toBe(false);
});

// ---- readiness polling + verify cache (faster apply) ----------------------

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

test('readiness: polls fast while booting, then confirms 3 passes in ~300ms', async () => {
  const c = fakeClock();
  let calls = 0;
  // not ready for the first 5 probes (~500ms boot), ready after
  const ok = await (await import('./activate')).waitReadyRepeated(async () => ++calls > 5, { now: c.now, sleep: c.sleep });
  expect(ok).toBe(true);
  expect(calls).toBe(8);
  expect(c.sleeps).toEqual([100, 100, 100, 100, 100, 150, 150]);
  // old loop: 300ms between every probe → first pass at 1800ms, ready at 2400ms
  expect(c.now()).toBe(800);
});

test('readiness: a flapping probe resets the pass count; times out when never ready', async () => {
  const c = fakeClock();
  const seq = [true, false, true, true, true];
  let i = 0;
  expect(await (await import('./activate')).waitReadyRepeated(async () => seq[i++] ?? false, { now: c.now, sleep: c.sleep })).toBe(true);
  expect(i).toBe(5);

  const c2 = fakeClock();
  expect(await (await import('./activate')).waitReadyRepeated(async () => { throw new Error('ECONNREFUSED'); }, { now: c2.now, sleep: c2.sleep, timeoutMs: 1000 })).toBe(false);
});

test('verifyArtifact: cached after a verify, re-hashes when the file changes, never trusts a wrong manifest sha', async () => {
  const { verifyArtifact, forgetVerified, sha256File, rememberVerified } = await import('./state');
  type Manifest = import('./state').Manifest;
  forgetVerified();
  const data = new Uint8Array(3_000_000).map((_, i) => i % 249);
  const dir = join(dataDir, 'cachetest');
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'showflow'), data);
  const sha = await sha256File(join(dir, 'showflow'));
  expect(sha).toBe(new Bun.CryptoHasher('sha256').update(data).digest('hex'));
  const manifest = { artifact: { name: 'showflow', sha256: sha } } as Manifest;

  await rememberVerified(join(dir, 'showflow'), sha);
  expect(await verifyArtifact(dir, manifest)).toBe(true);

  // Tamper (same size, new mtime) → fingerprint changes → real hash → mismatch.
  const bad = data.slice(); bad[0] = bad[0]! ^ 1;
  await Bun.write(join(dir, 'showflow'), bad);
  await utimes(join(dir, 'showflow'), new Date(), new Date(Date.now() + 5000));
  expect(await verifyArtifact(dir, manifest)).toBe(false);
  expect(await verifyArtifact(dir, { artifact: { name: 'showflow', sha256: '0'.repeat(64) } } as Manifest)).toBe(false);
  // Missing file
  expect(await verifyArtifact(join(dataDir, 'nope'), manifest)).toBe(false);
});
