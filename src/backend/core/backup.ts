import { Database } from 'bun:sqlite';
import { mkdir, readdir, stat, unlink, writeFile, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const DB = './showflow.db';

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
}

export interface BackupEntry {
  name: string;
  base: string;
  size: number;
  date: string;
  isDb: boolean;
  hasSql: boolean;
}

export const BACKUP_KEEP_COUNT_SETTING = 'backup.keepCount';
export const DEFAULT_BACKUP_KEEP_COUNT = 10;
export const MAX_BACKUP_KEEP_COUNT = 100;

/** Coerce a stored retention value into a sane keep-count (1..MAX). */
export function normalizeKeepCount(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BACKUP_KEEP_COUNT;
  return Math.min(MAX_BACKUP_KEEP_COUNT, Math.max(1, Math.floor(n)));
}

export async function listBackups(backupDir = 'backups'): Promise<BackupEntry[]> {
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
        date: dbStats.mtime.toISOString(),
        isDb: true,
        hasSql: !!sqlStats,
      });
    }

    return entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch {
    return [];
  }
}

export async function runBackup(backupDir = 'backups', keepCount = 10): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbFile = join(backupDir, `showflow-${timestamp}.db`);
  const sqlFile = join(backupDir, `showflow-${timestamp}.sql`);

  const src = new Database(DB);
  src.run(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  src.close();

  const dbStats = await stat(dbFile);

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

  await pruneBackups(backupDir, keepCount);

  dump.close();

  return {
    timestamp,
    dbFile,
    sqlFile,
    dbSize: dbStats.size,
    sqlSize: Buffer.byteLength(sqlContent),
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

export async function restoreBackup(name: string, dbPath: string, backupDir = 'backups'): Promise<void> {
  const src = join(backupDir, basename(name));
  await copyFile(src, dbPath);
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
  return deleted;
}

/**
 * Enforce the "keep newest N" retention policy. Backup units are grouped by
 * base name (each .db + its companion .sql counts as one) and ordered by
 * newest file mtime, so uploaded files with arbitrary names and .sql-only
 * orphans are pruned fairly instead of lingering forever. Returns the
 * deleted file names.
 */
export async function pruneBackups(backupDir = 'backups', keepCount = DEFAULT_BACKUP_KEEP_COUNT): Promise<string[]> {
  const keep = normalizeKeepCount(keepCount);
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

  const ordered = [...bases.entries()].sort((a, b) => b[1].mtime - a[1].mtime);
  const deleted: string[] = [];
  for (const [, entry] of ordered.slice(keep)) {
    for (const f of entry.files) {
      try {
        await unlink(join(backupDir, f));
        deleted.push(f);
      } catch {
        // raced with a manual delete — ignore
      }
    }
  }
  return deleted;
}

async function main() {
  const result = await runBackup();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main();
