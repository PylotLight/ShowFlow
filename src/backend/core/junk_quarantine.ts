import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../db';

/**
 * Junk-file quarantine for library roots.
 *
 * The library scanner walks show/movie folders that accumulate non-media
 * cruft over time (.DS_Store from macOS Samba shares, Thumbs.db,
 * downloader logs/partials, AppleDouble `._*` files, …). That cruft is
 * not parseable, not mappable, and previously just re-logged on every
 * scan forever.
 *
 * Policy (deliberately conservative — this MOVES user files):
 * - Only non-video files matching a tight known-cruft predicate are ever
 *   touched. Video containers, subtitles (.srt/.ass/.ssa/.vtt/.sub/.idx),
 *   metadata (.nfo), artwork (.jpg/.jpeg/.png/.webp/.tbn), chapters
 *   (.txt/.xml), and dotfiles in general (.nomedia etc.) are NEVER moved.
 * - Matches are moved (same-filesystem rename, EXDEV copy+delete fallback)
 *   into `<downloads>/.quarantine/` — never deleted on sight, so a false
 *   positive is recoverable.
 * - The daily `quarantine-cleanup` scheduler task permanently deletes
 *   quarantined files older than QUARANTINE_RETENTION_MS (1 day).
 * - Quarantined VIDEO files are never auto-deleted (defense in depth —
 *   nothing video should ever land here, but if it does it stays until a
 *   human looks at it).
 * - Unparseable / unknown-show VIDEO files are left in place entirely.
 *   They already have an owner: the blackhole watch folder + Manual Import
 *   page (manual-import holds), so the scanner must not relocate media.
 */

export const QUARANTINE_DIR_NAME = '.quarantine';

/** Quarantined junk older than this is permanently deleted by the daily sweep. */
export const QUARANTINE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Files larger than this are left in place (moving across filesystems is a
 * copy+delete — don't stall a library scan on a giant log). Rename on the
 * same filesystem is instant regardless of size, but when the quarantine
 * dir lives on another mount this cap keeps the scan bounded.
 */
export const QUARANTINE_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Exact basenames that are always safe to quarantine. */
const JUNK_BASENAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.localized',
  'download.log',
]);

/** Extensions (lowercased, without dot) of temp/partial/log cruft. */
const JUNK_EXTENSIONS = new Set([
  'tmp',
  'temp',
  'part',
  'aria2',
  'crdownload',
  'opdownload',
  'utpart',
  '!qb',
  'bts',
  'log',
]);

/**
 * True when `basename` is known non-media cruft safe to quarantine.
 * Case-insensitive. Deliberately narrow — unknown files are left alone.
 */
export function isQuarantinableJunk(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (JUNK_BASENAMES.has(lower)) return true;
  // AppleDouble metadata sidecars created by macOS on non-HFS shares.
  if (basename.startsWith('._')) return true;
  const ext = path.extname(lower);
  if (!ext) return false;
  return JUNK_EXTENSIONS.has(ext.slice(1));
}

/**
 * Resolve the downloads dir from config, i.e. where `.quarantine` lives.
 * Prefers the blackhole watch folder (the "downloads" landing dir), then
 * blackhole/torbox output folders. Returns null when nothing is configured
 * — callers must then leave junk in place.
 */
export function resolveDownloadsDir(config: Config): string | null {
  const dc = config.downloadClient as Config['downloadClient'] | undefined;
  const candidates = [
    dc?.blackhole?.watchFolder,
    dc?.blackhole?.outputFolder,
    dc?.torbox?.outputFolder,
  ];
  for (const c of candidates) {
    if (c?.trim()) return c.trim();
  }
  return null;
}

export function resolveQuarantineDir(config: Config): string | null {
  const downloads = resolveDownloadsDir(config);
  return downloads ? path.join(downloads, QUARANTINE_DIR_NAME) : null;
}

/** True when `file` already lives inside a quarantine dir (never re-move). */
export function isInsideQuarantine(file: string): boolean {
  return file.split(path.sep).includes(QUARANTINE_DIR_NAME);
}

async function moveFileCrossFsSafe(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    // Quarantine dir on another mount (e.g. library on hostPath /Data,
    // downloads on the /data PVC) — copy+delete. Junk is small/capped.
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

/**
 * Move a junk file into the quarantine dir with a collision-safe name.
 * Returns 'moved', 'skipped' (too big / vanished / already quarantined),
 * or 'dry' (dryRun — nothing touched).
 */
export async function quarantineFile(
  file: string,
  quarantineDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<'moved' | 'skipped' | 'dry'> {
  if (isInsideQuarantine(file)) return 'skipped';
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return 'skipped'; // vanished mid-scan
  }
  if (!stat.isFile() || stat.size > QUARANTINE_MAX_BYTES) return 'skipped';
  if (opts.dryRun) return 'dry';

  await fs.promises.mkdir(quarantineDir, { recursive: true });

  const base = path.basename(file);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dest = path.join(quarantineDir, base);
  for (let n = 1; ; n++) {
    try {
      await fs.promises.access(dest);
      dest = path.join(quarantineDir, `${stem} (${n})${ext}`);
    } catch {
      break; // dest is free
    }
  }

  try {
    await moveFileCrossFsSafe(file, dest);
    return 'moved';
  } catch {
    return 'skipped';
  }
}

const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.webm', '.mpg', '.mpeg',
]);

/**
 * Daily sweep: permanently delete quarantined files older than `maxAgeMs`
 * (default 1 day, by mtime). Only regular files directly inside the dir;
 * subdirectories are left alone. Video extensions are NEVER deleted no
 * matter their age — they stay for manual review.
 */
export async function cleanupQuarantine(
  quarantineDir: string,
  maxAgeMs: number = QUARANTINE_RETENTION_MS,
  now: number = Date.now(),
): Promise<{ deleted: number; kept: number; skippedVideo: number }> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(quarantineDir);
  } catch {
    return { deleted: 0, kept: 0, skippedVideo: 0 }; // nothing quarantined yet
  }

  let deleted = 0;
  let kept = 0;
  let skippedVideo = 0;
  for (const entry of entries) {
    const full = path.join(quarantineDir, entry);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // never touch subdirectories
    if (VIDEO_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      skippedVideo++;
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) {
      kept++;
      continue;
    }
    try {
      await fs.promises.unlink(full);
      deleted++;
    } catch {
      kept++;
    }
  }
  return { deleted, kept, skippedVideo };
}
