import type { DatabaseManager } from './index';

export interface TableStat {
  name: string;
  rowCount: number;
}

/**
 * Row counts for every real table in the DB, via sqlite_master
 * introspection - same approach backup.ts already uses to dump tables, so
 * this doesn't need updating every time schema.ts gains a table.
 */
export function getTableStats(self: DatabaseManager): TableStat[] {
  const tables = self.db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[];

  return tables
    .filter(t => !t.name.startsWith('__drizzle'))
    .map(t => {
      const row = self.db.query(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number } | undefined;
      return { name: t.name, rowCount: row?.c ?? 0 };
    });
}
