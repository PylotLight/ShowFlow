import { Database } from 'bun:sqlite';
import { mkdir, readdir, stat, unlink, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, linkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { resolveImagesDir, absImagePath, listImageFiles, unlinkRel } from './image_store';

const DB = './showflow.db';

/**
 * Artwork lives on disk now (core/image_store.ts), not in the DB, so a
 * VACUUM INTO copy alone would lose it. Each backup also snapshots the image
 * files its DB references into ONE shared, content-addressed store:
 *
 *   backups/images/<ab>/<sha1>.<ext>
 *
 * Files are immutable and named by hash, so they're hard-linked (zero extra
 * space on the same volume; plain copy otherwise) and shared by every
 * backup that references them — ten backups don't mean ten copies of the
 * posters. Pruning drops store files no remaining backup references, and a
 * restore copies back whatever the restored DB points at.
 *
 * A downloaded .db carries no images; restored on another box its artwork
 * simply re-warms from the providers (images are a re-fetchable cache).
 */
export const BACKUP_IMAGES_SUBDIR = 'images';

const SEED_INCLUDE_TABLES = new Set([
  'shows', 'show_providers', 'seasons', 'episodes', 'show_artworks',
  'root_folders', 'settings',
  'quality_definitions', 'quality_profiles', 'custom_formats', 'profile_formats',
]);

const EPHEMERAL_TABLES = new Set([
  'metadata_cache', 'audit_logs', 'scheduled_tasks', 'processed_files',
]);

export interface BackupResult {
  timestamp: string;
  dbFile: string;
  sqlFile: string;
  dbSize: number;
  sqlSize: number;
  /** Image files newly added to the shared backup image store. */
  imagesLinked?: number;
  /** Referenced images that weren't on disk (they'll re-warm on restore). */
  imagesMissing?: number;
}

export interface BackupEntry {
  name: string;
  base: string;
  /** .db file size. */
  size: number;
  /** Companion seed .sql size (0 when absent). */
  sqlSize?: number;
  date: string;
  isDb: boolean;
  hasSql: boolean;
  /** Which retention slot is keeping this backup (null = next prune drops it). */
  keptBy?: RetentionReason | null;
}

/** Legacy single "keep newest N" setting; still honoured as keepRecent. */
export const BACKUP_KEEP_COUNT_SETTING = 'backup.keepCount';
export const DEFAULT_BACKUP_KEEP_COUNT = 10;
export const MAX_BACKUP_KEEP_COUNT = 100;

// ---- Retention policy -----------------------------------------------------
//
// Grandfather-father-son instead of "newest 10": the newest `recent`
// backups always survive (so a manual backup right before a scheduled one
// isn't pruned), plus the newest backup of each of the last `daily` days
// that have one, plus the newest of each of the last `weekly` ISO weeks.

export type RetentionReason = 'recent' | 'daily' | 'weekly';

export interface RetentionPolicy {
  recent: number;
  daily: number;
  weekly: number;
}

export const BACKUP_KEEP_RECENT_SETTING = 'backup.keepRecent';
export const BACKUP_KEEP_DAILY_SETTING = 'backup.keepDaily';
export const BACKUP_KEEP_WEEKLY_SETTING = 'backup.keepWeekly';

export const DEFAULT_RETENTION: RetentionPolicy = { recent: 2, daily: 7, weekly: 4 };
const MAX_SLOT = 100;

function clampSlot(raw: unknown, fallback: number, min = 0): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SLOT, Math.max(min, Math.floor(n)));
}

/** Coerce raw values into a sane policy. Always keeps at least 1 backup. */
export function normalizeRetention(raw: Partial<Record<keyof RetentionPolicy, unknown>> | null | undefined): RetentionPolicy {
  const p = {
    recent: clampSlot(raw?.recent, DEFAULT_RETENTION.recent),
    daily: clampSlot(raw?.daily, DEFAULT_RETENTION.daily),
    weekly: clampSlot(raw?.weekly, DEFAULT_RETENTION.weekly),
  };
  if (p.recent + p.daily + p.weekly === 0) p.recent = 1;
  return p;
}

/**
 * Read the policy from settings. A legacy backup.keepCount (only present if
 * someone changed it from the default) becomes `recent` so an upgrade never
 * keeps fewer backups than the user asked for.
 */
export function loadRetention(getSetting: (key: string) => unknown): RetentionPolicy {
  const legacy = getSetting(BACKUP_KEEP_COUNT_SETTING);
  const recent = getSetting(BACKUP_KEEP_RECENT_SETTING) ?? (legacy != null ? normalizeKeepCount(legacy) : undefined);
  return normalizeRetention({
    recent,
    daily: getSetting(BACKUP_KEEP_DAILY_SETTING),
    weekly: getSetting(BACKUP_KEEP_WEEKLY_SETTING),
  });
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-8601 week key, e.g. "2026-W42" (UTC). */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Pure retention decision: which backup units survive and why. Units are
 * {key, mtime}; returns key -> reason for the kept ones (first matching
 * reason wins: recent, then daily, then weekly).
 */
export function selectRetained(units: { key: string; mtime: number }[], policy: RetentionPolicy): Map<string, RetentionReason> {
  const ordered = [...units].sort((a, b) => b.mtime - a.mtime);
  const kept = new Map<string, RetentionReason>();
  ordered.slice(0, policy.recent).forEach((u) => kept.set(u.key, 'recent'));

  const days = new Set<string>();
  for (const u of ordered) {
    const k = dayKey(u.mtime);
    if (days.has(k)) continue;
    if (days.size >= policy.daily) break;
    days.add(k);
    if (!kept.has(u.key)) kept.set(u.key, 'daily');
  }

  const weeks = new Set<string>();
  for (const u of ordered) {
    const k = isoWeekKey(u.mtime);
    if (weeks.has(k)) continue;
    if (weeks.size >= policy.weekly) break;
    weeks.add(k);
    if (!kept.has(u.key)) kept.set(u.key, 'weekly');
  }
  return kept;
}

/** Coerce a stored retention value into a sane keep-count (1..MAX). */
export function normalizeKeepCount(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BACKUP_KEEP_COUNT;
  return Math.min(MAX_BACKUP_KEEP_COUNT, Math.max(1, Math.floor(n)));
}

export async function listBackups(backupDir = 'backups', policy?: RetentionPolicy): Promise<BackupEntry[]> {
  try {
    const files = await readdir(backupDir);
    const dbs = files.filter(f => f.endsWith('.db'));
    const entries: BackupEntry[] = [];

    for (const dbFile of dbs) {
      const base = dbFile.replace(/\.db$/, '');
      const sqlFile = `${base}.sql`;
      const dbStats = await stat(join(backupDir, dbFile));
      let sqlStats: { size: number } | null = null;
      try {
        sqlStats = await stat(join(backupDir, sqlFile));
      } catch {}
      entries.push({
        name: dbFile,
        base: base.split('showflow-')[1] || base,
        size: dbStats.size,
        sqlSize: sqlStats?.size ?? 0,
        date: dbStats.mtime.toISOString(),
        isDb: true,
        hasSql: !!sqlStats,
      });
    }

    if (policy) {
      const kept = selectRetained(entries.map(e => ({ key: e.name, mtime: new Date(e.date).getTime() })), policy);
      for (const e of entries) e.keptBy = kept.get(e.name) ?? null;
    }

    return entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch {
    return [];
  }
}

export async function runBackup(
  backupDir = 'backups',
  policy: RetentionPolicy = DEFAULT_RETENTION,
  imagesDir: string = resolveImagesDir(DB),
): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbFile = join(backupDir, `showflow-${timestamp}.db`);
  const sqlFile = join(backupDir, `showflow-${timestamp}.sql`);

  // VACUUM INTO reads a single consistent snapshot (WAL included), so the
  // copy is safe while the app keeps writing — never fs-copy the .db file
  // directly under WAL, it'd miss pages still sitting in showflow.db-wal.
  const src = new Database(DB);
  src.run(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  src.close();

  const dbStats = await stat(dbFile);

  const images = snapshotBackupImages(dbFile, backupDir, imagesDir);

  const dump = new Database(DB);
  const tables = dump.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[];

  const lines: string[] = [
    '-- ShowFlow Database Seed',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Tables: ${tables.filter(t => SEED_INCLUDE_TABLES.has(t.name)).map(t => t.name).join(', ')}`,
    '',
    'PRAGMA foreign_keys = OFF;',
    '',
  ];

  const createStmts = dump.query(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as { name: string; sql: string | null }[];

  for (const stmt of createStmts) {
    if (stmt.sql) {
      lines.push(stmt.sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS') + ';');
      lines.push('');
    }
  }

  for (const { name: table } of tables) {
    if (!SEED_INCLUDE_TABLES.has(table)) continue;

    const rows = dump.query(`SELECT * FROM "${table}"`).all() as Record<string, any>[];
    if (rows.length === 0 || !rows[0]) continue;

    const columns = Object.keys(rows[0]).filter(c => table !== 'show_artworks' || c !== 'data');
    const colList = columns.map(c => `"${c}"`).join(', ');

    for (const row of rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        const escaped = String(val).replace(/'/g, "''");
        return `'${escaped}'`;
      }).join(', ');
      lines.push(`INSERT INTO "${table}" (${colList}) VALUES (${values});`);
    }
    lines.push('');
  }

  lines.push('PRAGMA foreign_keys = ON;');
  lines.push('');

  const sqlContent = lines.join('\n');
  await Bun.write(sqlFile, sqlContent);

  dump.close();

  await pruneBackups(backupDir, policy);

  return {
    timestamp,
    dbFile,
    sqlFile,
    dbSize: dbStats.size,
    sqlSize: Buffer.byteLength(sqlContent),
    imagesLinked: images.linked,
    imagesMissing: images.missing,
  };
}

export async function uploadBackup(buffer: Uint8Array, fileName: string, backupDir = 'backups'): Promise<BackupEntry> {
  await mkdir(backupDir, { recursive: true });
  // Sanitize filename to prevent path traversal
  const safeName = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = join(backupDir, safeName);
  await writeFile(dest, buffer);
  const stats = await stat(dest);
  const isDb = safeName.endsWith('.db');
  const base = safeName.replace(/\.(db|sql)$/, '');
  return {
    name: safeName,
    base,
    size: stats.size,
    date: stats.mtime.toISOString(),
    isDb,
    hasSql: false,
  };
}

export async function restoreBackup(name: string, dbPath: string, backupDir = 'backups', imagesDir: string = resolveImagesDir(dbPath)): Promise<void> {
  const src = join(backupDir, basename(name));
  await copyFile(src, dbPath);
  try {
    restoreBackupImages(dbPath, backupDir, imagesDir);
  } catch (err) {
    // Never fail a restore over artwork: missing files re-warm on demand.
    console.warn('[backup] could not restore image files:', err instanceof Error ? err.message : err);
  }
}

// ---- Image snapshot -------------------------------------------------------

/** image_path values referenced by a DB file (empty for pre-image-store DBs). */
export function referencedImagePaths(dbFile: string): string[] {
  let conn: Database | null = null;
  try {
    conn = new Database(dbFile, { readonly: true });
    const hasCol = conn.query("SELECT count(*) AS c FROM pragma_table_info('show_artworks') WHERE name = 'image_path'").get() as { c: number } | null;
    if (!hasCol?.c) return [];
    return (conn.query('SELECT DISTINCT image_path FROM show_artworks WHERE image_path IS NOT NULL').all() as { image_path: string }[])
      .map(r => r.image_path);
  } catch {
    return [];
  } finally {
    try { conn?.close(); } catch {}
  }
}

function linkOrCopy(src: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/** Add every image the backup DB references to the shared backup store. */
export function snapshotBackupImages(dbFile: string, backupDir: string, imagesDir: string): { linked: number; missing: number } {
  const store = join(backupDir, BACKUP_IMAGES_SUBDIR);
  let linked = 0;
  let missing = 0;
  for (const rel of referencedImagePaths(dbFile)) {
    const dest = absImagePath(store, rel);
    const src = absImagePath(imagesDir, rel);
    if (!dest || !src) continue;
    if (existsSync(dest)) continue;
    if (!existsSync(src)) { missing++; continue; }
    linkOrCopy(src, dest);
    linked++;
  }
  return { linked, missing };
}

/** Copy back any image the restored DB references that the live dir lacks. */
export function restoreBackupImages(dbFile: string, backupDir: string, imagesDir: string): number {
  const store = join(backupDir, BACKUP_IMAGES_SUBDIR);
  let restored = 0;
  for (const rel of referencedImagePaths(dbFile)) {
    const dest = absImagePath(imagesDir, rel);
    const src = absImagePath(store, rel);
    if (!dest || !src || existsSync(dest) || !existsSync(src)) continue;
    linkOrCopy(src, dest);
    restored++;
  }
  return restored;
}

/** Drop store files no remaining backup .db references. */
export async function pruneBackupImages(backupDir = 'backups'): Promise<number> {
  const store = join(backupDir, BACKUP_IMAGES_SUBDIR);
  const files = listImageFiles(store);
  if (files.length === 0) return 0;
  let dbs: string[] = [];
  try {
    dbs = (await readdir(backupDir)).filter(f => f.endsWith('.db'));
  } catch {}
  const referenced = new Set<string>();
  for (const f of dbs) for (const rel of referencedImagePaths(join(backupDir, f))) referenced.add(rel);
  let removed = 0;
  for (const f of files) {
    if (referenced.has(f.rel)) continue;
    if (unlinkRel(store, f.rel)) removed++;
  }
  return removed;
}

/** Total size + count of the shared backup image store. */
export function backupImagesUsage(backupDir = 'backups'): { files: number; bytes: number } {
  const files = listImageFiles(join(backupDir, BACKUP_IMAGES_SUBDIR));
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/**
 * Delete one backup and its companion file (.db deletes its .sql and
 * vice versa), so a manual delete never leaves an orphan behind.
 * Returns the list of file names actually removed.
 */
export async function deleteBackup(name: string, backupDir = 'backups'): Promise<string[]> {
  const safe = basename(name);
  if (!safe.endsWith('.db') && !safe.endsWith('.sql')) {
    throw new Error('Only .db and .sql backups can be deleted');
  }
  const base = safe.replace(/\.(db|sql)$/, '');
  const deleted: string[] = [];
  for (const candidate of [`${base}.db`, `${base}.sql`]) {
    try {
      await unlink(join(backupDir, candidate));
      deleted.push(candidate);
    } catch {
      // already gone — not an error
    }
  }
  if (deleted.length === 0) throw new Error(`Backup not found: ${safe}`);
  await pruneBackupImages(backupDir).catch(() => 0);
  return deleted;
}

/**
 * Enforce the retention policy (see selectRetained). Backup units are
 * grouped by base name (each .db + its companion .sql counts as one) and
 * dated by newest file mtime, so uploaded files with arbitrary names and
 * .sql-only orphans are pruned fairly instead of lingering forever. Then
 * drops image-store files no surviving backup references. Returns the
 * deleted backup file names.
 *
 * A bare number is still accepted (legacy "keep newest N" callers).
 */
export async function pruneBackups(backupDir = 'backups', policy: RetentionPolicy | number = DEFAULT_RETENTION): Promise<string[]> {
  const p: RetentionPolicy = typeof policy === 'number'
    ? { recent: normalizeKeepCount(policy), daily: 0, weekly: 0 }
    : normalizeRetention(policy);
  let files: string[];
  try {
    files = await readdir(backupDir);
  } catch {
    return [];
  }
  const relevant = files.filter(f => f.endsWith('.db') || f.endsWith('.sql'));
  if (relevant.length === 0) return [];

  const mtimes = new Map<string, number>();
  for (const f of relevant) {
    try {
      const st = await stat(join(backupDir, f));
      mtimes.set(f, st.mtimeMs);
    } catch {
      mtimes.set(f, 0);
    }
  }

  const bases = new Map<string, { files: string[]; mtime: number }>();
  for (const f of relevant) {
    const base = f.replace(/\.(db|sql)$/, '');
    const entry = bases.get(base) ?? { files: [], mtime: 0 };
    entry.files.push(f);
    entry.mtime = Math.max(entry.mtime, mtimes.get(f) ?? 0);
    bases.set(base, entry);
  }

  const kept = selectRetained([...bases.entries()].map(([key, e]) => ({ key, mtime: e.mtime })), p);
  const deleted: string[] = [];
  for (const [base, entry] of bases) {
    if (kept.has(base)) continue;
    for (const f of entry.files) {
      try {
        await unlink(join(backupDir, f));
        deleted.push(f);
      } catch {
        // raced with a manual delete — ignore
      }
    }
  }
  if (deleted.length > 0) await pruneBackupImages(backupDir);
  return deleted;
}

async function main() {
  const result = await runBackup();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main();
