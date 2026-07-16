import { db } from "../db";
import { runBackup, listBackups, uploadBackup, restoreBackup } from "../core/backup";
import { json, errorResponse } from "./_shared";
import path from "node:path";
import fs from "node:fs";

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
        try {
          const result = await runBackup();
          db.logEvent({ type: 'backup', message: `Backup created: ${result.dbFile}` });
          const entries = await listBackups();
          return json({ ...result, entries });
        } catch (err) {
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
        const p = path.join(process.cwd(), "backups", req.params.file!);
        if (fs.existsSync(p)) {
          return new Response(Bun.file(p));
        }
        return new Response("", { status: 404 });
      },
    },

  };
}
