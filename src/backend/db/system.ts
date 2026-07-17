import { eq, lt, desc, sql } from 'drizzle-orm';
import * as schema from './schema';
import { DEFAULT_CACHE_TTL_MS } from './schemas';
import type { DatabaseManager } from './index';

// ---- Processed files (dedup) ----

export function logProcessedFile(self: DatabaseManager, hash: string, original: string, final: string) {
  self.drizz
    .insert(schema.processedFiles)
    .values({ file_hash: hash, original_path: original, final_path: final })
    .onConflictDoUpdate({
      target: schema.processedFiles.file_hash,
      set: { original_path: original, final_path: final },
    })
    .run();
}

export function isProcessed(self: DatabaseManager, hash: string): boolean {
  const row = self.drizz.select({ file_hash: schema.processedFiles.file_hash })
    .from(schema.processedFiles)
    .where(eq(schema.processedFiles.file_hash, hash))
    .get();
  return !!row;
}

export function removeProcessedFile(self: DatabaseManager, hash: string) {
  self.drizz.delete(schema.processedFiles).where(eq(schema.processedFiles.file_hash, hash)).run();
}

// ---- Metadata cache ----

export function getCache<T = any>(self: DatabaseManager, key: string): T | null {
  const row = self.drizz.select({ raw_json: schema.metadataCache.raw_json, expires_at: schema.metadataCache.expires_at })
    .from(schema.metadataCache)
    .where(eq(schema.metadataCache.cache_key, key))
    .get();

  if (!row || !row.expires_at) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    self.drizz.delete(schema.metadataCache).where(eq(schema.metadataCache.cache_key, key)).run();
    return null;
  }

  try {
    return row.raw_json ? (JSON.parse(row.raw_json) as T) : null;
  } catch {
    return null;
  }
}

export function setCache(self: DatabaseManager, key: string, data: any, ttlMs: number = DEFAULT_CACHE_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const rawJson = JSON.stringify(data);
  self.drizz
    .insert(schema.metadataCache)
    .values({ cache_key: key, raw_json: rawJson, expires_at: expiresAt })
    .onConflictDoUpdate({
      target: schema.metadataCache.cache_key,
      set: { raw_json: rawJson, expires_at: expiresAt },
    })
    .run();
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
  const values = {
    name: task.name,
    interval_minutes: task.intervalMinutes,
    last_execution: task.lastExecution ?? null,
    last_duration_ms: task.lastDurationMs ?? null,
    next_execution: task.nextExecution ?? null,
    enabled: task.enabled === false ? 0 : 1,
  };
  self.drizz
    .insert(schema.scheduledTasks)
    .values(values)
    .onConflictDoUpdate({ target: schema.scheduledTasks.name, set: values })
    .run();
}

export function listTasks(self: DatabaseManager) {
  return self.drizz.select().from(schema.scheduledTasks).all();
}

export function updateTaskExecution(self: DatabaseManager, name: string, durationMs: number, nextExecution: string) {
  self.drizz
    .update(schema.scheduledTasks)
    .set({
      last_execution: new Date().toISOString(),
      last_duration_ms: durationMs,
      next_execution: nextExecution,
    })
    .where(eq(schema.scheduledTasks.name, name))
    .run();
}

// ---- Audit logs ----

export function logEvent(self: DatabaseManager, event: {
  type: string;
  entityType?: string;
  entityId?: string;
  message: string;
  metadata?: any;
}) {
  self.drizz
    .insert(schema.auditLogs)
    .values({
      event_type: event.type,
      entity_type: event.entityType ?? null,
      entity_id: event.entityId ?? null,
      message: event.message,
      metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
    })
    .run();
}

export function listRecentEvents(self: DatabaseManager, limit = 20) {
  return self.drizz
    .select()
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.id))
    .limit(limit)
    .all();
}

export function cleanupOldLogs(self: DatabaseManager, beforeDate: string) {
  const result = self.drizz.delete(schema.auditLogs).where(lt(schema.auditLogs.timestamp, beforeDate)).run() as unknown as { changes: number };
  return result.changes;
}

export function cleanupExpiredCache(self: DatabaseManager) {
  const result = self.drizz
    .delete(schema.metadataCache)
    .where(lt(schema.metadataCache.expires_at, new Date().toISOString()))
    .run() as unknown as { changes: number };
  return result.changes;
}

export interface CacheStats {
  total: number;
  expired: number;
}

/** Powers the analytics page's cache line - total vs. already-expired-but-not-yet-swept entries. */
export function getCacheStats(self: DatabaseManager): CacheStats {
  const nowIso = new Date().toISOString();
  const total = self.drizz.select({ c: sql<number>`count(*)` }).from(schema.metadataCache).get()?.c ?? 0;
  const expired = self.drizz.select({ c: sql<number>`count(*)` })
    .from(schema.metadataCache)
    .where(lt(schema.metadataCache.expires_at, nowIso))
    .get()?.c ?? 0;
  return { total, expired };
}
