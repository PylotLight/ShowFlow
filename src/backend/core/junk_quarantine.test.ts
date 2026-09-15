import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isQuarantinableJunk,
  resolveQuarantineDir,
  quarantineFile,
  cleanupQuarantine,
  QUARANTINE_DIR_NAME,
} from './junk_quarantine';

let tmpRoot = '';
let quarantineDir = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showflow-quarantine-'));
  quarantineDir = path.join(tmpRoot, 'downloads', QUARANTINE_DIR_NAME);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('junk predicate matches known cruft only', () => {
  expect(isQuarantinableJunk('.DS_Store')).toBe(true);
  expect(isQuarantinableJunk('Thumbs.db')).toBe(true);
  expect(isQuarantinableJunk('desktop.ini')).toBe(true);
  expect(isQuarantinableJunk('download.log')).toBe(true);
  expect(isQuarantinableJunk('._Poster.jpg')).toBe(true);
  expect(isQuarantinableJunk('movie.mkv.tmp')).toBe(true);
  expect(isQuarantinableJunk('episode.part')).toBe(true);
  expect(isQuarantinableJunk('file.aria2')).toBe(true);
});

test('junk predicate never matches media or legit sidecars', () => {
  expect(isQuarantinableJunk('Show - S01E01.mkv')).toBe(false);
  expect(isQuarantinableJunk('Show - S01E01.mp4')).toBe(false);
  expect(isQuarantinableJunk('Show.srt')).toBe(false);
  expect(isQuarantinableJunk('Show.nfo')).toBe(false);
  expect(isQuarantinableJunk('poster.jpg')).toBe(false);
  expect(isQuarantinableJunk('.nomedia')).toBe(false);
  expect(isQuarantinableJunk('.t3')).toBe(false);
  expect(isQuarantinableJunk('Season 1')).toBe(false);
});

test('resolveQuarantineDir prefers watch folder, null when unconfigured', () => {
  expect(resolveQuarantineDir({} as any)).toBeNull();
  expect(resolveQuarantineDir({ downloadClient: {} } as any)).toBeNull();
  expect(
    resolveQuarantineDir({ downloadClient: { blackhole: { watchFolder: '/dl' } } } as any),
  ).toBe(path.join('/dl', QUARANTINE_DIR_NAME));
  expect(
    resolveQuarantineDir({
      downloadClient: { blackhole: { watchFolder: '/watch', outputFolder: '/out' } },
    } as any),
  ).toBe(path.join('/watch', QUARANTINE_DIR_NAME));
});

test('quarantineFile moves junk and handles collisions', async () => {
  const lib = path.join(tmpRoot, 'Shows');
  fs.mkdirSync(lib, { recursive: true });
  const f1 = path.join(lib, '.DS_Store');
  fs.writeFileSync(f1, 'x');
  expect(await quarantineFile(f1, quarantineDir, {})).toBe('moved');
  expect(fs.existsSync(f1)).toBe(false);
  expect(fs.existsSync(path.join(quarantineDir, '.DS_Store'))).toBe(true);

  // Same basename again → collision-suffixed, original preserved.
  const sub = path.join(lib, 'Other');
  fs.mkdirSync(sub, { recursive: true });
  const f2 = path.join(sub, '.DS_Store');
  fs.writeFileSync(f2, 'y');
  expect(await quarantineFile(f2, quarantineDir, {})).toBe('moved');
  expect(fs.existsSync(path.join(quarantineDir, '.DS_Store (1)'))).toBe(true);
});

test('quarantineFile respects dryRun and skips quarantined paths', async () => {
  const f = path.join(tmpRoot, '.DS_Store');
  fs.writeFileSync(f, 'x');
  expect(await quarantineFile(f, quarantineDir, { dryRun: true })).toBe('dry');
  expect(fs.existsSync(f)).toBe(true);

  const already = path.join(quarantineDir, 'old.log');
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.writeFileSync(already, 'x');
  expect(await quarantineFile(already, quarantineDir, {})).toBe('skipped');
});

test('cleanupQuarantine deletes only expired non-video files', async () => {
  fs.mkdirSync(quarantineDir, { recursive: true });
  const oldLog = path.join(quarantineDir, 'download.log');
  const freshLog = path.join(quarantineDir, 'fresh.log');
  const oldVideo = path.join(quarantineDir, 'stray.mkv');
  fs.writeFileSync(oldLog, 'x');
  fs.writeFileSync(freshLog, 'x');
  fs.writeFileSync(oldVideo, 'x');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldLog, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(oldVideo, twoDaysAgo, twoDaysAgo);

  const res = await cleanupQuarantine(quarantineDir);
  expect(res.deleted).toBe(1);
  expect(res.kept).toBe(1);
  expect(res.skippedVideo).toBe(1);
  expect(fs.existsSync(oldLog)).toBe(false);
  expect(fs.existsSync(freshLog)).toBe(true);
  expect(fs.existsSync(oldVideo)).toBe(true);
});

test('cleanupQuarantine is a no-op when the dir does not exist', async () => {
  const res = await cleanupQuarantine(path.join(tmpRoot, 'nope'));
  expect(res).toEqual({ deleted: 0, kept: 0, skippedVideo: 0 });
});

test('library scan quarantines junk into downloads/.quarantine, leaves media alone', async () => {
  const { db } = await import('../db/index');
  const { LibraryScanner } = await import('./library_scanner');

  const runId = `quar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const libRoot = path.join(tmpRoot, 'Shows');
  const downloads = path.join(tmpRoot, 'downloads');
  fs.mkdirSync(libRoot, { recursive: true });

  const junk = path.join(libRoot, '.DS_Store');
  const media = path.join(libRoot, 'Some Show - S01E01 - Pilot WEBRip-1080p.mkv');
  fs.writeFileSync(junk, 'x');
  fs.writeFileSync(media, 'x');

  db.saveLibraryType({ id: `${runId}-lib`, name: `${runId} lib`, rootFolderPath: libRoot });
  try {
    const scanner = new LibraryScanner({
      downloadClient: { blackhole: { watchFolder: downloads } },
    } as any);
    await scanner.scan();

    expect(fs.existsSync(junk)).toBe(false);
    expect(fs.existsSync(path.join(downloads, QUARANTINE_DIR_NAME, '.DS_Store'))).toBe(true);
    // Unmapped video stays put for the Manual Import flow — never quarantined.
    expect(fs.existsSync(media)).toBe(true);
  } finally {
    db.removeLibraryType(`${runId}-lib`);
  }
});
