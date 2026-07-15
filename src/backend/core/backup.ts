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

  // Prune old backups
  const files = await readdir(backupDir);
  for (const ext of ['.db', '.sql']) {
    const byExt = files.filter(f => f.endsWith(ext)).sort().reverse();
    if (byExt.length > keepCount) {
      for (const old of byExt.slice(keepCount)) {
        await unlink(join(backupDir, old));
      }
    }
  }

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

async function main() {
  const result = await runBackup();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main();
