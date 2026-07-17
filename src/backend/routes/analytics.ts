import { stat } from 'node:fs/promises';
import { db } from '../db';
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
  };
}
