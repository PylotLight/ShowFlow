import { DEFAULT_CACHE_TTL_MS } from './schemas';
import type { DatabaseManager } from './index';

// ---- Processed files (dedup) ----

export function logProcessedFile(self: DatabaseManager, hash: string, original: string, final: string) {
  self.db.run(
    'INSERT OR REPLACE INTO processed_files (file_hash, original_path, final_path) VALUES (?, ?, ?)',
    [hash, original, final]
  );
}

export function isProcessed(self: DatabaseManager, hash: string): boolean {
  const row = self.db.query('SELECT file_hash FROM processed_files WHERE file_hash = ?').get(hash);
  return !!row;
}

export function removeProcessedFile(self: DatabaseManager, hash: string) {
  self.db.run('DELETE FROM processed_files WHERE file_hash = ?', [hash]);
}

// ---- Metadata cache ----

export function getCache<T = any>(self: DatabaseManager, key: string): T | null {
  const row = self.db.query('SELECT raw_json, expires_at FROM metadata_cache WHERE cache_key = ?').get(key) as
    | { raw_json: string; expires_at: string }
    | undefined;

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    self.db.run('DELETE FROM metadata_cache WHERE cache_key = ?', [key]);
    return null;
  }

  try {
    return JSON.parse(row.raw_json) as T;
  } catch {
    return null;
  }
}

export function setCache(self: DatabaseManager, key: string, data: any, ttlMs: number = DEFAULT_CACHE_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  self.db.run(
    'INSERT OR REPLACE INTO metadata_cache (cache_key, raw_json, expires_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(data), expiresAt]
  );
}

// ---- Tasks ----

export function saveTask(self: DatabaseManager, task: {
  name: string;
  intervalMinutes: number;
  lastExecution?: string;
  lastDurationMs?: number;
  nextExecution?: string;
  enabled?: boolean;
}) {
  self.db.run(
    'INSERT OR REPLACE INTO scheduled_tasks (name, interval_minutes, last_execution, last_duration_ms, next_execution, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [task.name, task.intervalMinutes, task.lastExecution ?? null, task.lastDurationMs ?? null, task.nextExecution ?? null, task.enabled ?? 1]
  );
}

export function listTasks(self: DatabaseManager) {
  return self.db.query('SELECT * FROM scheduled_tasks').all() as any[];
}

export function updateTaskExecution(self: DatabaseManager, name: string, durationMs: number, nextExecution: string) {
  self.db.run('UPDATE scheduled_tasks SET last_execution = CURRENT_TIMESTAMP, last_duration_ms = ?, next_execution = ? WHERE name = ?', [durationMs, nextExecution, name]);
}

// ---- Audit logs ----

export function logEvent(self: DatabaseManager, event: {
  type: string;
  entityType?: string;
  entityId?: string;
  message: string;
  metadata?: any;
}) {
  self.db.run(
    'INSERT INTO audit_logs (event_type, entity_type, entity_id, message, metadata_json) VALUES (?, ?, ?, ?, ?)',
    [event.type, event.entityType ?? null, event.entityId ?? null, event.message, event.metadata ? JSON.stringify(event.metadata) : null]
  );
}

export function listRecentEvents(self: DatabaseManager, limit = 20) {
  return self.db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) as any[];
}

export function cleanupOldLogs(self: DatabaseManager, beforeDate: string) {
  const result = self.db.run('DELETE FROM audit_logs WHERE timestamp < ?', [beforeDate]);
  return result.changes;
}

export function cleanupExpiredCache(self: DatabaseManager) {
  const result = self.db.run('DELETE FROM metadata_cache WHERE expires_at < CURRENT_TIMESTAMP');
  return result.changes;
}
