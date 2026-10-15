/**
 * Background job: move legacy show_artworks.data blobs out to files
 * (core/image_store.ts), then sweep image files nothing references.
 *
 * - Not on the startup path: server.ts kicks it off on a timer after boot.
 * - Resumable for free: each batch selects rows that still have a blob, so a
 *   restart mid-way just picks up where it stopped. A row is only switched
 *   to its file (and its blob nulled) after the file is fully written.
 * - Small batches with a pause in between so it never hogs the single
 *   SQLite writer while the app is serving.
 */
import type { DatabaseManager } from '../db';
import { writeImage, listImageFiles, unlinkRel } from './image_store';
import { backgroundJobs } from './background_jobs';

export interface ImageMigrationResult {
  moved: number;
  failed: number;
  bytesMoved: number;
  orphansRemoved: number;
}

export interface ImageMigrationOptions {
  batchSize?: number;
  pauseMs?: number;
  /** Stop after this many batches (tests). */
  maxBatches?: number;
  /** Files younger than this are never swept (a write may be mid-flight). */
  orphanMinAgeMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function countPendingArtworkBlobs(db: DatabaseManager): number {
  const row = db.db.query('SELECT count(*) AS c FROM show_artworks WHERE data IS NOT NULL').get() as { c: number } | null;
  return row?.c ?? 0;
}

/** Move one batch of blobs to disk. Returns rows handled (0 = done). */
export function migrateArtworkBatch(db: DatabaseManager, batchSize = 20): { handled: number; moved: number; failed: number; bytes: number; lastId: number } {
  return migrateBatchAfter(db, 0, batchSize);
}

function migrateBatchAfter(db: DatabaseManager, afterId: number, batchSize: number) {
  const rows = db.db.query(
    'SELECT id, data, content_type FROM show_artworks WHERE data IS NOT NULL AND id > ? ORDER BY id LIMIT ?',
  ).all(afterId, batchSize) as { id: number; data: Uint8Array; content_type: string | null }[];
  let moved = 0;
  let failed = 0;
  let bytes = 0;
  let lastId = afterId;
  const update = db.db.query(
    'UPDATE show_artworks SET image_hash = ?, image_path = ?, byte_size = ?, data = NULL WHERE id = ?',
  );
  const clear = db.db.query('UPDATE show_artworks SET data = NULL WHERE id = ?');
  for (const row of rows) {
    lastId = row.id;
    try {
      if (!row.data || row.data.byteLength === 0) {
        clear.run(row.id);
        continue;
      }
      const stored = writeImage(db.imagesDir, row.data, row.content_type);
      update.run(stored.hash, stored.path, stored.size, row.id);
      moved++;
      bytes += stored.size;
    } catch (err) {
      // Leave the blob in place (still served from the DB) and move on;
      // the next run retries it.
      failed++;
      console.warn(`[images] could not move artwork ${row.id} to disk:`, err instanceof Error ? err.message : err);
    }
  }
  return { handled: rows.length, moved, failed, bytes, lastId };
}

/**
 * Delete files under the images dir that no row references (left behind by
 * a crash between write and row update, or by deletes that predate GC).
 */
export function sweepOrphanImages(db: DatabaseManager, minAgeMs = 60 * 60 * 1000): number {
  const files = listImageFiles(db.imagesDir);
  if (files.length === 0) return 0;
  const referenced = new Set(
    (db.db.query('SELECT DISTINCT image_path FROM show_artworks WHERE image_path IS NOT NULL').all() as { image_path: string }[])
      .map((r) => r.image_path),
  );
  const cutoff = Date.now() - minAgeMs;
  let removed = 0;
  for (const f of files) {
    if (referenced.has(f.rel)) continue;
    if (f.mtimeMs > cutoff) continue;
    if (unlinkRel(db.imagesDir, f.rel)) removed++;
  }
  return removed;
}

let running: Promise<ImageMigrationResult> | null = null;

export function runImageMigration(db: DatabaseManager, opts: ImageMigrationOptions = {}): Promise<ImageMigrationResult> {
  if (running) return running;
  const job = (async () => {
    const batchSize = opts.batchSize ?? 20;
    const pauseMs = opts.pauseMs ?? 250;
    const result: ImageMigrationResult = { moved: 0, failed: 0, bytesMoved: 0, orphansRemoved: 0 };
    const total = countPendingArtworkBlobs(db);
    let jobId: string | null = null;
    if (total > 0) {
      jobId = crypto.randomUUID();
      backgroundJobs.register({ id: jobId, type: 'image-migration', label: 'Moving artwork out of the database', total });
    }
    try {
      let afterId = 0;
      let batches = 0;
      while (opts.maxBatches === undefined || batches < opts.maxBatches) {
        const b = migrateBatchAfter(db, afterId, batchSize);
        if (b.handled === 0) break;
        afterId = b.lastId;
        batches++;
        result.moved += b.moved;
        result.failed += b.failed;
        result.bytesMoved += b.bytes;
        if (jobId) backgroundJobs.update(jobId, { completed: result.moved + result.failed, detail: `${result.moved}/${total} images moved` });
        if (pauseMs > 0) await sleep(pauseMs);
      }
      result.orphansRemoved = sweepOrphanImages(db, opts.orphanMinAgeMs);
      if (jobId) {
        backgroundJobs.complete(jobId, `${result.moved} images moved (${(result.bytesMoved / 1024 / 1024).toFixed(1)} MB)${result.failed ? `, ${result.failed} failed` : ''}`);
      }
      if (result.moved > 0) {
        db.logEvent({ type: 'maintenance', message: `Moved ${result.moved} artwork images out of the database (${(result.bytesMoved / 1024 / 1024).toFixed(1)} MB)` });
      }
      return result;
    } catch (err) {
      if (jobId) backgroundJobs.fail(jobId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  })();
  // Clear the guard after the job settles (not inside it: with no awaits the
  // body can finish before `running` is even assigned).
  running = job.finally(() => { running = null; });
  return running;
}
