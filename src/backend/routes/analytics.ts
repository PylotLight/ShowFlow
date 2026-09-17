import { stat } from 'node:fs/promises';
import { db } from '../db';
import { backgroundJobs } from '../core/background_jobs';
import { runDbCleanup, type DbCleanupAction } from '../core/db_cleanup';
import { json, errorResponse } from './_shared';

const DB_PATH = './showflow.db';

/**
 * DB usage/analytics for the Settings > Analytics page - overall file size,
 * per-table row counts, and a closer look at pipeline_events specifically
 * since it's by far the highest-write-volume table (every search can add
 * several rows). Not part of systemRoutes() because it doesn't need the
 * scheduler/systemManager instances those routes are wired with.
 */
export function analyticsRoutes() {
  return {
    "/api/system/analytics": {
      async GET() {
        try {
          let dbSizeBytes = 0;
          try {
            const stats = await stat(DB_PATH);
            dbSizeBytes = stats.size;
          } catch {
            // DB file not found at the expected relative path (e.g. custom
            // working directory) - report 0 rather than failing the whole
            // endpoint, the table stats below are still useful on their own.
          }

          const tables = db.getTableStats();
          const pipelineEvents = db.getPipelineEventStats();
          const hourlyActivity = db.getHourlyPipelineEventCounts(24);
          const noisiestShows = db.getNoisiestShows(5);
          const cache = db.getCacheStats();

          return json({ dbSizeBytes, tables, pipelineEvents, hourlyActivity, noisiestShows, cache });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/health": {
      async GET() {
        try {
          return json(db.getHealthSnapshot());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/db-cleanup": {
      // User-triggered DB sweeps for Settings > Analytics (issues #28/#29).
      // Purges on big tables take minutes, so the work runs as a background
      // job — this returns a jobId immediately and the UI polls
      // GET /api/background-jobs/:id. Never await runDbCleanup inline here:
      // Cloudflare kills HTTP responses past ~100s and the pod looks wedged.
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json().catch(() => ({}))) as { action?: string; keepDays?: number };
          const action = body.action as DbCleanupAction;
          if (!['prune-episode-files', 'purge-scan-logs', 'vacuum'].includes(action)) {
            return errorResponse("action must be 'prune-episode-files', 'purge-scan-logs' or 'vacuum'", 400);
          }
          const keepDays = Math.min(90, Math.max(1, Math.floor(body.keepDays ?? 7)));
          const jobId = crypto.randomUUID();
          const label = action === 'vacuum'
            ? 'Vacuum database'
            : action === 'prune-episode-files'
              ? 'Prune episode-file history'
              : `Purge scan logs (keep ${keepDays}d)`;
          backgroundJobs.register({ id: jobId, type: 'db-cleanup', label });

          runDbCleanup(action, {
            keepDays,
            onProgress: (completed, detail) => backgroundJobs.update(jobId, { completed, detail }),
          }).then(
            (result) => {
              backgroundJobs.complete(jobId, result.detail);
              db.logEvent({ type: 'maintenance', entityType: 'system', message: `DB cleanup: ${result.detail}` });
            },
            (err) => backgroundJobs.fail(jobId, err instanceof Error ? err.message : String(err)),
          );

          return json({ jobId });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
