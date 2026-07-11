import { Database } from 'bun:sqlite';

const DB_PATH = './showflow.db';

function migrate() {
  const db = new Database(DB_PATH);
  db.run('PRAGMA foreign_keys = OFF');

  console.log('[migrate] Starting migration...');

  const oldShows = db.query('SELECT * FROM shows').all() as any[];
  console.log(`[migrate] Found ${oldShows.length} existing shows`);

  let migrated = 0;
  for (const old of oldShows) {
    const uuid = old.uuid || crypto.randomUUID();
    const pt = old.provider_type as string;

    db.run(
      `INSERT OR IGNORE INTO shows (id, title, original_title, year, profile, config_json, root_folder_path, sort_title, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid,
        old.title || '',
        old.original_title || null,
        old.year || null,
        old.profile || 'standard',
        old.config_json || null,
        old.root_folder_path || null,
        (old.title || '').toLowerCase(),
        old.last_updated || new Date().toISOString(),
      ]
    );

    db.run(
      `INSERT OR IGNORE INTO show_providers (show_id, provider_type, provider_id, title, original_title, year, metadata_json, is_primary, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        uuid,
        pt,
        old.provider_id,
        old.title || '',
        old.original_title || null,
        old.year || null,
        old.provider_metadata || null,
        old.last_updated || null,
      ]
    );

    db.run('UPDATE seasons SET show_id = ? WHERE show_id = ?', [uuid, old.provider_id]);
    db.run('UPDATE episodes SET show_id = ? WHERE show_id = ?', [uuid, old.provider_id]);

    db.run(
      `UPDATE show_artworks SET show_id = ?, provider_type = ?, artwork_type = CASE artwork_type WHEN 2 THEN 'poster' WHEN 3 THEN 'fanart' WHEN 15 THEN 'background' ELSE 'unknown' END WHERE show_id = ?`,
      [uuid, pt, old.provider_id]
    );

    migrated++;
  }

  db.run('PRAGMA foreign_keys = ON');
  console.log(`[migrate] Migration complete. Migrated ${migrated} shows.`);
  db.close();
}

migrate();