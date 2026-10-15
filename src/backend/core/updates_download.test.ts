import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Streams the release tarball to disk with progress + sha256 check, then hands
// off to the supervisor — all with fetch faked, so nothing leaves the box.
const dataDir = await mkdtemp(join(tmpdir(), 'sf-upd-'));
const prevEnv = { data: process.env.SHOWFLOW_DATA_DIR, repo: process.env.GITHUB_REPO };
process.env.SHOWFLOW_DATA_DIR = dataDir;
process.env.GITHUB_REPO = 'example/showflow';

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (prevEnv.data === undefined) delete process.env.SHOWFLOW_DATA_DIR; else process.env.SHOWFLOW_DATA_DIR = prevEnv.data;
  if (prevEnv.repo === undefined) delete process.env.GITHUB_REPO; else process.env.GITHUB_REPO = prevEnv.repo;
  await rm(dataDir, { recursive: true, force: true });
});

const payload = new Uint8Array(300_000).map((_, i) => i % 251);
const sha = new Bun.CryptoHasher('sha256').update(payload).digest('hex');

test('downloadAndInstallByTag streams to disk, verifies digest, reports progress, calls the supervisor', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/releases/tags/v9.9.9')) {
      return Response.json({ tag_name: 'v9.9.9', assets: [{ id: 42, name: 'showflow-deadbeef.tar.gz', size: payload.byteLength, digest: `sha256:${sha}` }] });
    }
    if (url.endsWith('/releases/assets/42')) {
      // Chunked body so progress fires more than once.
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < payload.byteLength; i += 50_000) c.enqueue(payload.slice(i, i + 50_000));
          c.close();
        },
      });
      return new Response(stream, { headers: { 'content-length': String(payload.byteLength) } });
    }
    if (url.endsWith('/admin/install-archive')) {
      const body = JSON.parse(init.body);
      expect(body.releaseId).toBe('deadbeef');
      const onDisk = new Uint8Array(await Bun.file(body.tarball).arrayBuffer());
      expect(onDisk.byteLength).toBe(payload.byteLength);
      return Response.json({ ok: true, message: 'Installed release "deadbeef".' });
    }
    return new Response('nope', { status: 404 });
  }) as any;

  const { downloadAndInstallByTag, getDownloadProgress } = await import('./updates_manager');
  const seen: number[] = [];
  const result = await downloadAndInstallByTag('v9.9.9', (received) => seen.push(received));
  expect(result).toMatchObject({ ok: true, releaseId: 'deadbeef' });
  expect(seen.at(-1)).toBe(payload.byteLength);
  expect(getDownloadProgress()).toMatchObject({ tag: 'v9.9.9', phase: 'staged', receivedBytes: payload.byteLength });
  // .part was renamed away; only the final tarball is left.
  expect(await readdir(join(dataDir, 'downloads', 'deadbeef'))).toEqual(['release.tar.gz']);
  expect(calls.some((u) => u.endsWith('/admin/install-archive'))).toBe(true);
});

test('a release without the tarball asset yet is a soft failure, not a throw', async () => {
  globalThis.fetch = (async (input: any) => {
    if (String(input).endsWith('/releases/tags/v9.9.10')) return Response.json({ tag_name: 'v9.9.10', assets: [] });
    return new Response('nope', { status: 404 });
  }) as any;
  const { downloadAndInstallByTag, getDownloadProgress } = await import('./updates_manager');
  const result = await downloadAndInstallByTag('v9.9.10');
  expect(result.ok).toBe(false);
  expect(result.message).toContain('CI may still be building');
  expect(getDownloadProgress()?.phase).toBe('error');
});

test('a prerelease-suffixed tag is skipped without touching the network', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => { calls.push(String(input)); return new Response('nope', { status: 404 }); }) as any;
  const { downloadAndInstallByTag } = await import('./updates_manager');
  const r = await downloadAndInstallByTag('v9.9.9-test.1');
  expect(r).toMatchObject({ ok: false, skipped: true });
  expect(calls).toEqual([]);
});

test('a release GitHub flags as prerelease or draft is skipped before any download', async () => {
  for (const flag of [{ prerelease: true }, { draft: true }]) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/releases/tags/v9.9.11')) {
        return Response.json({ tag_name: 'v9.9.11', ...flag, assets: [{ id: 7, name: 'showflow-cafe.tar.gz', size: 1 }] });
      }
      return new Response('nope', { status: 404 });
    }) as any;
    const { downloadAndInstallByTag } = await import('./updates_manager');
    const r = await downloadAndInstallByTag('v9.9.11');
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(calls.some((u) => u.includes('/releases/assets/'))).toBe(false);
  }
});

test('never re-stages the release that is running (ETXTBSY guard)', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/admin/status')) return Response.json({ phase: 'stable', active: 'cafef00d', activeReleaseId: 'cafef00d' });
    if (url.endsWith('/releases/tags/v0.1.81')) {
      return Response.json({ tag_name: 'v0.1.81', assets: [{ id: 7, name: 'showflow-cafef00d.tar.gz', size: 10 }] });
    }
    return new Response('nope', { status: 404 });
  }) as any;
  const { downloadAndInstallByTag } = await import('./updates_manager');
  const r = await downloadAndInstallByTag('v0.1.81');
  expect(r).toMatchObject({ ok: false, alreadyActive: true, releaseId: 'cafef00d' });
  expect(calls.some((u) => u.includes('/releases/assets/'))).toBe(false);
  expect(calls.some((u) => u.endsWith('/admin/install-archive'))).toBe(false);
});

test('listReleases: the running sha is current, only newer releases are updates', async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes('/releases?')) {
      return Response.json([
        { id: 3, tag_name: 'v0.1.82', assets: [{ id: 30, name: 'showflow-bbbb.tar.gz', size: 1 }] },
        { id: 2, tag_name: 'v0.1.81', assets: [{ id: 20, name: 'showflow-aaaa.tar.gz', size: 1 }] },
        { id: 1, tag_name: 'v0.1.80', assets: [{ id: 10, name: 'showflow-9999.tar.gz', size: 1 }] },
      ]);
    }
    return new Response('nope', { status: 404 });
  }) as any;
  const { listReleases } = await import('./updates_manager');
  // Stamp unknown ("main"), but the supervisor says we're running aaaa.
  const a = await listReleases({ version: null, releaseId: 'aaaa' }, 7);
  expect(a.releases.map((r) => [r.tagName, r.relation, r.isLikelyCurrent])).toEqual([
    ['v0.1.82', 'unknown', false],
    ['v0.1.81', 'current', true],
    ['v0.1.80', 'unknown', false],
  ]);
  // Version resolved: same (cached) list, relation recomputed.
  const b = await listReleases({ version: 'v0.1.81', releaseId: 'aaaa' }, 7);
  expect(b.releases.map((r) => r.relation)).toEqual(['newer', 'current', 'older']);
});
