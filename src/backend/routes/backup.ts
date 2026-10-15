import { db } from "../db";
import {
  runBackup, listBackups, uploadBackup, restoreBackup, deleteBackup, pruneBackups,
  loadRetention, normalizeRetention, backupImagesUsage, DEFAULT_RETENTION,
  BACKUP_KEEP_RECENT_SETTING, BACKUP_KEEP_DAILY_SETTING, BACKUP_KEEP_WEEKLY_SETTING,
  type RetentionPolicy,
} from "../core/backup";
import { backgroundJobs } from "../core/background_jobs";
import { json, errorResponse } from "./_shared";
import path from "node:path";
import fs from "node:fs";

function getRetention(): RetentionPolicy {
  try {
    return loadRetention((k) => db.getSetting(k));
  } catch {
    return DEFAULT_RETENTION;
  }
}

function saveRetention(p: RetentionPolicy) {
  db.setSetting(BACKUP_KEEP_RECENT_SETTING, p.recent);
  db.setSetting(BACKUP_KEEP_DAILY_SETTING, p.daily);
  db.setSetting(BACKUP_KEEP_WEEKLY_SETTING, p.weekly);
}

const list = () => listBackups('backups', getRetention());

export function backupRoutes() {
  return {

    "/api/backup": {
      GET: async () => {
        try {
          const entries = await list();
          return json(entries);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      POST: async () => {
        const jobId = crypto.randomUUID();
        backgroundJobs.register({ id: jobId, type: 'backup', label: 'Database backup' });
        try {
          const result = await runBackup('backups', getRetention(), db.imagesDir);
          backgroundJobs.complete(jobId, `Backup created: ${result.dbFile}`);
          db.logEvent({ type: 'backup', message: `Backup created: ${result.dbFile}` });
          const entries = await list();
          return json({ ...result, entries });
        } catch (err) {
          backgroundJobs.fail(jobId, err instanceof Error ? err.message : String(err));
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backups/upload": {
      POST: async (req: Request & { params: Record<string, string> }) => {
        try {
          const form = await req.formData();
          const file = form.get("file") as File | null;
          if (!file) return new Response("No file provided", { status: 400 });

          const buf = await file.bytes();
          const entry = await uploadBackup(buf, file.name);
          return json(entry);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backups/:file/restore": {
      POST: async (req: Request & { params: Record<string, string> }) => {
        try {
          const file = req.params.file!;
          await db.replaceFile((dbPath) => restoreBackup(file, dbPath, 'backups', db.imagesDir));
          db.logEvent({ type: 'restore', message: `Database restored from backup: ${file}` });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backups/:file": {
      GET(req: Request & { params: Record<string, string> }) {
        const safe = path.basename(req.params.file ?? "");
        if (!safe) return new Response("", { status: 404 });
        const p = path.join(process.cwd(), "backups", safe);
        if (fs.existsSync(p)) {
          return new Response(Bun.file(p));
        }
        return new Response("", { status: 404 });
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          const safe = path.basename(req.params.file ?? "");
          if (!safe) return errorResponse("Backup file is required", 400);
          const deleted = await deleteBackup(safe);
          db.logEvent({ type: 'backup', message: `Backup deleted: ${deleted.join(', ')}` });
          const entries = await list();
          return json({ ok: true, deleted, entries });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found')) return errorResponse(msg, 404);
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backup/summary": {
      GET() {
        try {
          return json({ retention: getRetention(), images: backupImagesUsage('backups') });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backup/prune": {
      // Body { retention?: {recent,daily,weekly} } saves the policy first,
      // then prunes against it; an empty body prunes with the stored policy.
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json().catch(() => ({})) as { retention?: Partial<RetentionPolicy> };
          let policy = getRetention();
          if (body.retention && typeof body.retention === 'object') {
            policy = normalizeRetention({ ...policy, ...body.retention });
            saveRetention(policy);
          }
          const deleted = await pruneBackups('backups', policy);
          if (deleted.length > 0) {
            db.logEvent({ type: 'backup', message: `Pruned ${deleted.length} old backup file(s) (keeping ${policy.recent} recent, ${policy.daily} daily, ${policy.weekly} weekly)` });
          }
          const entries = await list();
          return json({ ok: true, deleted, retention: policy, entries, images: backupImagesUsage('backups') });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
