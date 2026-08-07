import { db } from "../db";
import { sql } from "drizzle-orm";
import type { Scheduler } from "../core/scheduler";
import type { SystemManager } from "../core/system_manager";
import { backgroundJobs } from "../core/background_jobs";
import { json, errorResponse } from "./_shared";

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "development";
const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "development";

export function systemRoutes(scheduler: Scheduler, systemManager: SystemManager, shuttingDownRef: () => boolean) {
  return {

    "/api/system/scan": {
      async POST() {
        const jobId = crypto.randomUUID();
        backgroundJobs.register({ id: jobId, type: 'library-scan', label: 'Library scan' });
        try {
          const result = await systemManager.scan();
          backgroundJobs.complete(jobId, 'Library scan completed');
          db.logEvent({ type: 'scan', entityType: 'system', message: 'Full library scan completed' });
          return json({ ok: true, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          backgroundJobs.fail(jobId, message);
          db.logEvent({ type: 'error', entityType: 'system', message: `Library scan failed: ${message}` });
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/watch/start": {
      async POST() {
        try {
          const result = await systemManager.startWatcher();
          db.logEvent({ type: 'watcher', entityType: 'system', message: 'Watcher services started' });
          return json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.logEvent({ type: 'error', entityType: 'system', message: `Failed to start watcher: ${message}` });
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/watch/stop": {
      async POST() {
        try {
          const result = await systemManager.stopWatcher();
          db.logEvent({ type: 'watcher', entityType: 'system', message: 'Watcher services stopped' });
          return json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.logEvent({ type: 'error', entityType: 'system', message: `Failed to stop watcher: ${message}` });
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/watch/rescan": {
      async POST() {
        try {
          const result = await systemManager.rescanWatcher();
          db.logEvent({ type: 'scan', entityType: 'system', message: 'Watch folder rescan completed' });
          return json(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.logEvent({ type: 'error', entityType: 'system', message: `Watch folder rescan failed: ${message}` });
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/status": {
      async GET() {
        try {
          return json({
            watching: systemManager.isWatching(),
            releaseId: BUILD_COMMIT,
            version: BUILD_VERSION,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/memory": {
      async GET() {
        try {
          return json(systemManager.getMemoryStats());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/processing": {
      async GET() {
        try {
          return json(systemManager.getProcessingFiles());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/tasks": {
      async GET() {
        try {
          const tasks = db.listTasks();
          const definitions = scheduler.getTaskDefinitions();

          const enrichedTasks = tasks.map((task: any) => {
            const def = definitions.find(d => d.name === task.name);
            return {
              name: task.name,
              displayName: def?.displayName || task.name,
              description: def?.description || '',
              category: def?.category || 'system',
              intervalMinutes: task.interval_minutes,
              enabled: !!task.enabled,
              lastExecution: task.last_execution,
              lastDurationMs: task.last_duration_ms,
              nextExecution: task.next_execution,
            };
          });

          return json(enrichedTasks);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/tasks/definitions": {
      async GET() {
        try {
          return json(scheduler.getTaskDefinitions());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/tasks/:name": {
      async PATCH(req: Request & { params: Record<string, string> }) {
        try {
          const name = req.params.name!;
          if (!name) return errorResponse("Task name is required", 400);
          const body = await req.json();

          scheduler.updateTaskConfig(name, {
            enabled: body.enabled,
            intervalMinutes: body.intervalMinutes,
          });

          return json({ success: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const name = req.params.name!;
          if (!name) return errorResponse("Task name is required", 400);
          const result = await scheduler.runTaskNow(name);
          return json(result);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/internal/ready": {
      async GET() {
        if (shuttingDownRef()) {
          return json({ ready: false, error: "shutting down" }, { status: 503 });
        }
        try {
          db.drizz.get(sql`select 1`);
          return json({
            ready: true,
            releaseId: BUILD_COMMIT,
            version: BUILD_VERSION,
            database: "ready",
          });
        } catch (err) {
          return json({ ready: false, error: String(err) }, { status: 503 });
        }
      },
    },

  };
}
