import type { DatabaseManager } from './index';

function normalizeIndexers(v: unknown): string[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [...(Array.isArray((v as any).tv) ? (v as any).tv : []), ...(Array.isArray((v as any).anime) ? (v as any).anime : [])];
  return [];
}

// ---- Show Profiles ----

export function listShowProfiles(self: DatabaseManager): { id: string; name: string; root_folder_path: string }[] {
  return self.db.query('SELECT * FROM show_profiles ORDER BY name ASC').all() as { id: string; name: string; root_folder_path: string }[];
}

export function saveShowProfile(self: DatabaseManager, id: string, name: string, rootFolderPath: string) {
  self.db.run('INSERT OR REPLACE INTO show_profiles (id, name, root_folder_path) VALUES (?, ?, ?)', [id, name, rootFolderPath]);
}

export function removeShowProfile(self: DatabaseManager, id: string) {
  self.db.run('DELETE FROM show_profiles WHERE id = ?', [id]);
}

export function getShowProfileRootFolder(self: DatabaseManager, profileId: string): string | null {
  const row = self.db.query('SELECT root_folder_path FROM show_profiles WHERE id = ?').get(profileId) as { root_folder_path: string } | undefined;
  return row?.root_folder_path ?? null;
}

// ---- Settings ----

export function getSetting(self: DatabaseManager, key: string) {
  const row = self.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(self: DatabaseManager, key: string, value: any) {
  const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
  self.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, val]);
}

export function removeSetting(self: DatabaseManager, key: string) {
  self.db.run('DELETE FROM settings WHERE key = ?', [key]);
}

export function getAllSettings(self: DatabaseManager) {
  return self.db.query('SELECT * FROM settings').all() as { key: string; value: string }[];
}

// ---- Quality ----

export function saveQuality(self: DatabaseManager, q: { id: string; name: string; rank: number; minSize?: number; maxSize?: number }) {
  self.db.run(
    'INSERT OR REPLACE INTO quality_definitions (id, name, rank, min_size, max_size) VALUES (?, ?, ?, ?, ?)',
    [q.id, q.name, q.rank, q.minSize ?? null, q.maxSize ?? null]
  );
}

export function getQuality(self: DatabaseManager, id: string) {
  return self.db.query('SELECT * FROM quality_definitions WHERE id = ?').get(id) as any;
}

export function removeQuality(self: DatabaseManager, id: string) {
  self.db.run('DELETE FROM quality_definitions WHERE id = ?', [id]);
}

export function listQualities(self: DatabaseManager) {
  return self.db.query('SELECT * FROM quality_definitions ORDER BY rank DESC').all() as any[];
}

// ---- Quality Profiles ----

export function saveProfile(self: DatabaseManager, p: { id: string; name: string; cutoffId?: string; indexers?: string }) {
  const indexersStr = p.indexers ?? '{}';
  self.db.run(
    'INSERT OR REPLACE INTO quality_profiles (id, name, cutoff_quality_id, indexers) VALUES (?, ?, ?, ?)',
    [p.id, p.name, p.cutoffId ?? null, indexersStr]
  );
}

export function saveProfileIndexers(self: DatabaseManager, id: string, indexers: Record<string, string[]>) {
  self.db.run(
    'UPDATE quality_profiles SET indexers = ? WHERE id = ?',
    [JSON.stringify(indexers), id]
  );
}

export function getProfileIndexers(self: DatabaseManager, id: string): string[] {
  const row = self.db.query('SELECT indexers FROM quality_profiles WHERE id = ?').get(id) as any;
  if (!row?.indexers) return [];
  try {
    return normalizeIndexers(JSON.parse(row.indexers));
  } catch {
    return [];
  }
}

export function resolveProfileId(self: DatabaseManager, id: string | null | undefined): string | undefined {
  if (id && getProfile(self, id)) return id;
  const profiles = listProfiles(self);
  return profiles.length > 0 ? profiles[0].id : undefined;
}

export function getProfile(self: DatabaseManager, id: string) {
  const row = self.db.query('SELECT * FROM quality_profiles WHERE id = ?').get(id) as any;
  if (row?.indexers) {
    try { row.indexers = normalizeIndexers(JSON.parse(row.indexers)); } catch { row.indexers = []; }
  }
  return row;
}

export function removeProfile(self: DatabaseManager, id: string) {
  self.db.run('DELETE FROM quality_profiles WHERE id = ?', [id]);
}

export function listProfiles(self: DatabaseManager) {
  const rows = self.db.query('SELECT * FROM quality_profiles').all() as any[];
  for (const row of rows) {
    if (row.indexers) {
      try { row.indexers = normalizeIndexers(JSON.parse(row.indexers)); } catch { row.indexers = []; }
    }
  }
  return rows;
}

// ---- Custom Formats ----

export function saveCustomFormat(self: DatabaseManager, f: { id: string; name: string; regex: string; score: number }) {
  self.db.run(
    'INSERT OR REPLACE INTO custom_formats (id, name, regex, score) VALUES (?, ?, ?, ?)',
    [f.id, f.name, f.regex, f.score]
  );
}

export function getCustomFormat(self: DatabaseManager, id: string) {
  return self.db.query('SELECT * FROM custom_formats WHERE id = ?').get(id) as any;
}

export function removeCustomFormat(self: DatabaseManager, id: string) {
  self.db.run('DELETE FROM custom_formats WHERE id = ?', [id]);
}

export function listCustomFormats(self: DatabaseManager) {
  return self.db.query('SELECT * FROM custom_formats').all() as any[];
}

// ---- Profile-Format mapping ----

export function addProfileFormat(self: DatabaseManager, profileId: string, formatId: string, type: 'bonus' | 'required' | 'forbidden' = 'bonus') {
  self.db.run('INSERT OR REPLACE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)', [profileId, formatId, type]);
}

export function removeProfileFormat(self: DatabaseManager, profileId: string, formatId: string) {
  self.db.run('DELETE FROM profile_formats WHERE profile_id = ? AND format_id = ?', [profileId, formatId]);
}

export function getProfileFormats(self: DatabaseManager, profileId: string) {
  return self.db.query(`
    SELECT cf.*, pf.type as profile_format_type
    FROM custom_formats cf
    JOIN profile_formats pf ON cf.id = pf.format_id
    WHERE pf.profile_id = ?
  `).all(profileId) as any[];
}

// ---- Profile-Quality mapping ----

export function addProfileQuality(self: DatabaseManager, profileId: string, qualityId: string) {
  self.db.run('INSERT OR IGNORE INTO profile_qualities (profile_id, quality_id) VALUES (?, ?)', [profileId, qualityId]);
}

export function removeProfileQuality(self: DatabaseManager, profileId: string, qualityId: string) {
  self.db.run('DELETE FROM profile_qualities WHERE profile_id = ? AND quality_id = ?', [profileId, qualityId]);
}

export function getProfileQualities(self: DatabaseManager, profileId: string) {
  return self.db.query(`
    SELECT qd.*
    FROM quality_definitions qd
    JOIN profile_qualities pq ON qd.id = pq.quality_id
    WHERE pq.profile_id = ?
    ORDER BY qd.rank DESC
  `).all(profileId) as any[];
}
