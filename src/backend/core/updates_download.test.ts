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

// ---- inline extraction → /admin/install (no supervisor gunzip pass) -------

async function buildReleaseTarball(dir: string, binary: Uint8Array): Promise<Uint8Array> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'src', 'migrations', 'meta'), { recursive: true });
  await Bun.write(join(dir, 'src', 'showflow'), binary);
  const binSha = new Bun.CryptoHasher('sha256').update(binary).digest('hex');
  await Bun.write(join(dir, 'src', 'manifest.json'), JSON.stringify({ releaseId: 'c0ffee', commit: 'c0ffee', readyPath: '/internal/ready', artifact: { name: 'showflow', sha256: binSha } }));
  await Bun.write(join(dir, 'src', 'migrations', '0000_init.sql'), 'select 1;');
  await Bun.write(join(dir, 'src', 'migrations', 'meta', '_journal.json'), '{"entries":[]}');
  // Same shape CI packages (docker-image.yml "Package release assets").
  const p = Bun.spawnSync(['tar', '-czf', join(dir, 'out.tgz'), '-C', join(dir, 'src'), 'showflow', 'manifest.json', 'migrations']);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return new Uint8Array(await Bun.file(join(dir, 'out.tgz')).arrayBuffer());
}

function serveRelease(tag: string, assetId: number, name: string, tgz: Uint8Array, supervisor: (path: string, body: any) => Response, calls: string[]) {
  const tgzSha = new Bun.CryptoHasher('sha256').update(tgz).digest('hex');
  return (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith(`/releases/tags/${tag}`)) {
      return Response.json({ tag_name: tag, assets: [{ id: assetId, name, size: tgz.byteLength, digest: `sha256:${tgzSha}` }] });
    }
    if (url.endsWith(`/releases/assets/${assetId}`)) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < tgz.byteLength; i += 7_777) c.enqueue(tgz.slice(i, i + 7_777));
          c.close();
        },
      });
      return new Response(stream, { headers: { 'content-length': String(tgz.byteLength) } });
    }
    if (url.endsWith('/admin/status')) return Response.json({ phase: 'stable', activeReleaseId: 'someother' });
    if (url.includes('/admin/')) return supervisor(new URL(url).pathname, JSON.parse(init.body));
    return new Response('nope', { status: 404 });
  }) as any;
}

test('a real release tarball is unpacked while downloading and installed via /admin/install', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sf-tgz-'));
  const binary = new Uint8Array(600_000).map((_, i) => (i * 7) % 256);
  const tgz = await buildReleaseTarball(work, binary);
  const calls: string[] = [];
  globalThis.fetch = serveRelease('v9.9.20', 77, 'showflow-c0ffee.tar.gz', tgz, (path, body) => {
    expect(path).toBe('/admin/install');
    expect(body).toEqual({ releaseId: 'c0ffee' });
    return Response.json({ ok: true, message: 'Installed release "c0ffee".' });
  }, calls);
  const { downloadAndInstallByTag, getDownloadProgress } = await import('./updates_manager');
  const r = await downloadAndInstallByTag('v9.9.20');
  expect(r).toMatchObject({ ok: true, releaseId: 'c0ffee' });
  const dir = join(dataDir, 'downloads', 'c0ffee');
  expect(new Uint8Array(await Bun.file(join(dir, 'showflow')).arrayBuffer())).toEqual(binary);
  expect(await Bun.file(join(dir, 'migrations', 'meta', '_journal.json')).text()).toBe('{"entries":[]}');
  expect(calls.some((u) => u.endsWith('/admin/install-archive'))).toBe(false);
  expect(getDownloadProgress()?.timings).toMatchObject({ extractedInline: true, supervisorPath: 'install' });
  await rm(work, { recursive: true, force: true });
});

test('falls back to /admin/install-archive when the supervisor has no /admin/install', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sf-tgz-'));
  const tgz = await buildReleaseTarball(work, new Uint8Array(10_000).fill(3));
  const paths: string[] = [];
  globalThis.fetch = serveRelease('v9.9.21', 78, 'showflow-c0ffee.tar.gz', tgz, (path) => {
    paths.push(path);
    if (path === '/admin/install') return new Response('Not found', { status: 404 });
    return Response.json({ ok: true, message: 'Installed via archive.' });
  }, []);
  const { downloadAndInstallByTag, getDownloadProgress } = await import('./updates_manager');
  const r = await downloadAndInstallByTag('v9.9.21');
  expect(r.ok).toBe(true);
  expect(paths).toEqual(['/admin/install', '/admin/install-archive']);
  expect(getDownloadProgress()?.timings?.supervisorPath).toBe('install-archive');
  await rm(work, { recursive: true, force: true });
});

test('handOffToSupervisor: a real /admin/install failure (e.g. checksum) is reported, not retried via archive', async () => {
  const { handOffToSupervisor } = await import('./updates_manager');
  const paths: string[] = [];
  const r = await handOffToSupervisor('abc', true, async (p) => { paths.push(p); return { ok: false, message: 'Artifact checksum mismatch', status: 400 }; });
  expect(r).toMatchObject({ ok: false, path: 'install' });
  expect(paths).toEqual(['/admin/install']);
  const r2 = await handOffToSupervisor('abc', false, async (p) => { paths.push(p); return { ok: true, message: 'ok', status: 200 }; });
  expect(r2.path).toBe('install-archive');
});

test('inlineExtractUsable requires the streamed binary hash to match the manifest', async () => {
  const { inlineExtractUsable } = await import('./updates_manager');
  const entries = [{ path: 'showflow', size: 1, sha256: 'aa' }, { path: 'manifest.json', size: 1 }];
  expect(inlineExtractUsable(entries, { artifact: { name: 'showflow', sha256: 'AA' } })).toBe(true);
  expect(inlineExtractUsable(entries, { artifact: { name: 'showflow', sha256: 'bb' } })).toBe(false);
  expect(inlineExtractUsable(null, { artifact: { name: 'showflow', sha256: 'aa' } })).toBe(false);
  expect(inlineExtractUsable(entries, null)).toBe(false);
});
