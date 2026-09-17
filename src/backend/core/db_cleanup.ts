import { stat } from 'node:fs/promises';
import { db } from '../db';
import { debugLog } from './debug';

export type DbCleanupAction = 'prune-episode-files' | 'purge-scan-logs' | 'vacuum';

export interface DbCleanupOptions {
  /** Keep scan-type audit rows newer than this (days). Default 7. */
  keepDays?: number;
  /** Progress callback (completed, total?) for background-job updates. */
  onProgress?: (completed: number, detail: string) => void;
}

export interface DbCleanupResult {
  action: DbCleanupAction;
  removedRows: number;
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  detail: string;
}

const DB_PATH = './showflow.db';
const PURGE_CHUNK = 100_000;

async function dbSizeBytes(): Promise<number> {
  try {
    return (await stat(DB_PATH)).size;
  } catch {
    return 0;
  }
}

/** Yield to the event loop between heavy chunks so HTTP/readiness stay alive. */
function yieldLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * User-triggered database sweeps for Settings > Analytics (issues-tracking
 * #29). Long-running by design — callers must run this inside a background
 * job (see routes/analytics.ts), never awaited inline in a request handler,
 * because multi-million-row purges and VACUUM each take minutes.
 */
export async function runDbCleanup(action: DbCleanupAction, opts: DbCleanupOptions = {}): Promise<DbCleanupResult> {
  const sizeBeforeBytes = await dbSizeBytes();
  const report = opts.onProgress ?? (() => {});

  if (action === 'prune-episode-files') {
    report(0, 'Pruning superseded episode-file rows…');
    const removed = db.pruneSupersededEpisodeFiles();
    await yieldLoop();
    const sizeAfterBytes = await dbSizeBytes();
    return {
      action, removedRows: removed, sizeBeforeBytes, sizeAfterBytes,
      detail: `Pruned ${removed.toLocaleString()} superseded episode-file row(s) — live row + latest superseded row kept per episode`,
    };
  }

  if (action === 'purge-scan-logs') {
    const keepDays = opts.keepDays ?? 7;
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    report(0, 'Building cleanup index (one-time)…');
    db.ensureCleanupIndexes();
    await yieldLoop();
    let removed = 0;
    for (;;) {
      const n = db.purgeOldScanLogs(cutoff, PURGE_CHUNK);
      removed += n;
      report(removed, `Purged ${removed.toLocaleString()} scan log row(s)…`);
      if (n < PURGE_CHUNK) break;
      await yieldLoop();
    }
    const sizeAfterBytes = await dbSizeBytes();
    return {
      action, removedRows: removed, sizeBeforeBytes, sizeAfterBytes,
      detail: `Purged ${removed.toLocaleString()} scan-type audit row(s) older than ${keepDays} day(s) — errors, grabs and other event types untouched`,
    };
  }

  // vacuum
  report(0, 'Vacuuming database — the UI may 502 until this finishes…');
  await yieldLoop();
  db.db.run('VACUUM');
  const sizeAfterBytes = await dbSizeBytes();
  debugLog(`DB vacuum complete: ${(sizeBeforeBytes / 1024 / 1024).toFixed(0)}MB -> ${(sizeAfterBytes / 1024 / 1024).toFixed(0)}MB`);
  return {
    action, removedRows: 0, sizeBeforeBytes, sizeAfterBytes,
    detail: `Vacuum complete: ${(sizeBeforeBytes / 1048576).toFixed(1)} GiB -> ${(sizeAfterBytes / 1048576).toFixed(1)} GiB`,
  };
}
