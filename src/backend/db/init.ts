import type { Database } from 'bun:sqlite';

export function createTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS shows (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      original_title TEXT,
      year INTEGER,
      profile TEXT DEFAULT 'standard',
      series_type TEXT DEFAULT 'standard',
      root_folder_path TEXT,
      sort_title TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      last_updated TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.run(`ALTER TABLE shows ADD COLUMN series_type TEXT DEFAULT 'standard'`); } catch { }
  try { db.run(`ALTER TABLE shows DROP COLUMN config_json`); } catch { }

  db.run(`
    CREATE TABLE IF NOT EXISTS show_providers (
      show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL DEFAULT 'local',
      provider_id TEXT NOT NULL,
      title TEXT,
      original_title TEXT,
      year INTEGER,
      metadata_json TEXT,
      is_primary INTEGER DEFAULT 0,
      is_metadata INTEGER DEFAULT 0,
      is_airtime INTEGER DEFAULT 0,
      last_synced TEXT,
      PRIMARY KEY (show_id, provider_type)
    )
  `);
  try { db.run(`ALTER TABLE show_providers ADD COLUMN is_metadata INTEGER DEFAULT 0`); } catch { }
  try { db.run(`ALTER TABLE show_providers ADD COLUMN is_airtime INTEGER DEFAULT 0`); } catch { }

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_show_providers_provider
    ON show_providers(provider_type, provider_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS show_titles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      language TEXT,
      title_type TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'local',
      created_at TEXT DEFAULT (datetime('now')),
      last_updated TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_show_titles_normalized_title
    ON show_titles(normalized_title)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_show_titles_show_id
    ON show_titles(show_id)
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_show_titles_show_normalized_type
    ON show_titles(show_id, normalized_title, title_type, provider_type)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS seasons (
      show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
      season_number INTEGER NOT NULL,
      title TEXT,
      last_updated TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (show_id, season_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS episodes (
      show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
      season_number INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      absolute_number INTEGER,
      title TEXT,
      file_path TEXT,
      is_tracked INTEGER DEFAULT 0,
      air_date TEXT,
      search_mode TEXT DEFAULT 'auto',
      last_updated TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (show_id, season_number, episode_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS show_artworks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL DEFAULT 'local',
      artwork_type TEXT NOT NULL,
      image_url TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      thumbnail TEXT,
      content_type TEXT,
      data BLOB,
      UNIQUE(show_id, provider_type, artwork_type)
    )
  `);

  // Legacy tables

  db.run(`
    CREATE TABLE IF NOT EXISTS processed_files (
      file_hash TEXT PRIMARY KEY,
      original_path TEXT,
      final_path TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metadata_cache (
      cache_key TEXT PRIMARY KEY,
      raw_json TEXT,
      expires_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      name TEXT PRIMARY KEY,
      interval_minutes INTEGER,
      last_execution DATETIME,
      last_duration_ms INTEGER,
      next_execution DATETIME,
      enabled BOOLEAN DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quality_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rank INTEGER DEFAULT 0,
      min_size INTEGER,
      max_size INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quality_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cutoff_quality_id TEXT,
      indexers TEXT DEFAULT '{}',
      FOREIGN KEY (cutoff_quality_id) REFERENCES quality_definitions(id)
    )
  `);
  try { db.run(`ALTER TABLE quality_profiles ADD COLUMN indexers TEXT DEFAULT '{}'`); } catch { }

  db.run(`
    CREATE TABLE IF NOT EXISTS custom_formats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      regex TEXT NOT NULL,
      score INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS profile_formats (
      profile_id TEXT,
      format_id TEXT,
      type TEXT DEFAULT 'bonus',
      PRIMARY KEY (profile_id, format_id),
      FOREIGN KEY (profile_id) REFERENCES quality_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (format_id) REFERENCES custom_formats(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS profile_qualities (
      profile_id TEXT,
      quality_id TEXT,
      PRIMARY KEY (profile_id, quality_id),
      FOREIGN KEY (profile_id) REFERENCES quality_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (quality_id) REFERENCES quality_definitions(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS show_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_folder_path TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_type TEXT,
      entity_type TEXT,
      entity_id TEXT,
      message TEXT,
      metadata_json TEXT
    )
  `);
}

export function seedDefaults(db: Database): void {
  migrateQualityIds(db);

  const qualities: { id: string; name: string; rank: number }[] = [
    { id: 'q_sdtv', name: 'SDTV', rank: 1 },
    { id: 'q_dvd', name: 'DVD', rank: 2 },
    { id: 'q_480p', name: '480p', rank: 10 },
    { id: 'q_webrip_480p', name: 'WEBRip-480p', rank: 11 },
    { id: 'q_webdl_480p', name: 'WEBDL-480p', rank: 12 },
    { id: 'q_720p', name: '720p', rank: 20 },
    { id: 'q_hdtv_720p', name: 'HDTV-720p', rank: 21 },
    { id: 'q_webrip_720p', name: 'WEBRip-720p', rank: 22 },
    { id: 'q_webdl_720p', name: 'WEBDL-720p', rank: 23 },
    { id: 'q_bluray_720p', name: 'Bluray-720p', rank: 24 },
    { id: 'q_1080p', name: '1080p', rank: 30 },
    { id: 'q_hdtv_1080p', name: 'HDTV-1080p', rank: 31 },
    { id: 'q_webrip_1080p', name: 'WEBRip-1080p', rank: 32 },
    { id: 'q_webdl_1080p', name: 'WEBDL-1080p', rank: 33 },
    { id: 'q_bluray_1080p', name: 'Bluray-1080p', rank: 34 },
    { id: 'q_remux_1080p', name: 'Remux-1080p', rank: 35 },
    { id: 'q_2160p', name: '2160p', rank: 40 },
    { id: 'q_hdtv_2160p', name: 'HDTV-2160p', rank: 41 },
    { id: 'q_webrip_2160p', name: 'WEBRip-2160p', rank: 42 },
    { id: 'q_webdl_2160p', name: 'WEBDL-2160p', rank: 43 },
    { id: 'q_bluray_2160p', name: 'Bluray-2160p', rank: 44 },
    { id: 'q_remux_2160p', name: 'Remux-2160p', rank: 45 },
  ];
  for (const q of qualities) {
    db.run(
      'INSERT OR IGNORE INTO quality_definitions (id, name, rank) VALUES (?, ?, ?)',
      [q.id, q.name, q.rank]
    );
  }

  const formats: { id: string; name: string; regex: string; score: number }[] = [
    { id: 'f_hdr', name: 'HDR', regex: 'HDR', score: 50 },
    { id: 'f_x265', name: 'x265', regex: 'x265', score: 10 },
    { id: 'f_hevc', name: 'HEVC', regex: 'HEVC', score: 10 },
    { id: 'f_h265', name: 'H265', regex: 'H265', score: 10 },
  ];
  for (const f of formats) {
    db.run(
      'INSERT OR IGNORE INTO custom_formats (id, name, regex, score) VALUES (?, ?, ?, ?)',
      [f.id, f.name, f.regex, f.score]
    );
  }

  db.run(`INSERT OR IGNORE INTO quality_profiles (id, name) VALUES ('standard', 'Standard')`);
  for (const f of ['f_hdr', 'f_x265', 'f_h265']) {
    db.run(
      'INSERT OR IGNORE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)',
      ['standard', f, 'bonus']
    );
  }

  db.run(`INSERT OR IGNORE INTO quality_profiles (id, name) VALUES ('anime', 'Anime')`);
  for (const f of ['f_x265', 'f_hevc', 'f_h265']) {
    db.run(
      'INSERT OR IGNORE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)',
      ['anime', f, 'bonus']
    );
  }
}

export function migrateQualityIds(db: Database): void {
  db.run(`DELETE FROM quality_definitions WHERE id IN ('q1', 'q2', 'q3', 'q4')`);
}
