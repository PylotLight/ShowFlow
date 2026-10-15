import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, readdir, stat } from 'node:fs/promises';
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
