import { db } from "../db";
import { runBackup, listBackups, uploadBackup, restoreBackup, deleteBackup, pruneBackups, normalizeKeepCount, BACKUP_KEEP_COUNT_SETTING, DEFAULT_BACKUP_KEEP_COUNT } from "../core/backup";
import { backgroundJobs } from "../core/background_jobs";
import { json, errorResponse } from "./_shared";
import path from "node:path";
import fs from "node:fs";

function getKeepCount(): number {
  try {
    return normalizeKeepCount(db.getSetting(BACKUP_KEEP_COUNT_SETTING) ?? DEFAULT_BACKUP_KEEP_COUNT);
  } catch {
    return DEFAULT_BACKUP_KEEP_COUNT;
  }
}

export function backupRoutes() {
  return {

    "/api/backup": {
      GET: async () => {
        try {
          const entries = await listBackups();
          return json(entries);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      POST: async () => {
        const jobId = crypto.randomUUID();
        backgroundJobs.register({ id: jobId, type: 'backup', label: 'Database backup' });
        try {
          const result = await runBackup('backups', getKeepCount());
          backgroundJobs.complete(jobId, `Backup created: ${result.dbFile}`);
          db.logEvent({ type: 'backup', message: `Backup created: ${result.dbFile}` });
          const entries = await listBackups();
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
          await restoreBackup(file, 'showflow.db');
          db.reload();
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
          const entries = await listBackups();
          return json({ ok: true, deleted, entries });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('not found')) return errorResponse(msg, 404);
          return errorResponse(err, 500);
        }
      },
    },
    "/api/backup/prune": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json().catch(() => ({})) as { keepCount?: unknown };
          const keep = body.keepCount !== undefined ? normalizeKeepCount(body.keepCount) : getKeepCount();
          const deleted = await pruneBackups('backups', keep);
          if (deleted.length > 0) {
            db.logEvent({ type: 'backup', message: `Pruned ${deleted.length} old backup file(s), keeping newest ${keep}` });
          }
          const entries = await listBackups();
          return json({ ok: true, deleted, keepCount: keep, entries });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
