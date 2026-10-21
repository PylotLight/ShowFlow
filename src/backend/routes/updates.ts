import { db } from "../db";
import { listReleases, downloadAndInstall, getSupervisorStatus, getDownloadProgress, updateJobs } from "../core/updates_manager";
import { runWatchCycle, getPendingUpdate, isAutoDownloadEnabled, setAutoDownload, getDownloadFailure, recordStaged } from "../core/update_watcher";
import { UpdateBusyError } from "../core/update_jobs";
import {
  startActivation,
  getActivationProgress,
  getLastActivation,
  getAutoActivate,
  setAutoActivate,
  pendingMigrationsFor,
  currentBusy,
  getUpdateMode,
  setUpdateMode,
  isAlreadyStaged,
  startInstantUpdateFor,
} from "../core/update_activation";
import { normalizeAutoActivate } from "../core/update_policy";
import { getCurrentRelease } from "../core/current_release";
import { json, errorResponse, checkAdminAuth, unauthorized } from "./_shared";

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "development";
const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "development";

export function updateRoutes(adminToken: string) {
  return {

    "/api/admin/token": {
      GET() {
        return json({ token: adminToken });
      },
    },

    "/api/admin/updates/available": {
      async GET(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const url = new URL(req.url);
          const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
          const current = await getCurrentRelease();
          const result = await listReleases(current, page);
          return json({ current: { releaseId: current.releaseId ?? BUILD_COMMIT, version: current.display, buildVersion: BUILD_VERSION }, ...result });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/install": {
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const { githubReleaseId } = (await req.json()) as { githubReleaseId?: number };
          if (!githubReleaseId) return errorResponse("githubReleaseId is required");
          // Joins the watcher's download of the same release instead of
          // racing it, and skips the fetch when it's already staged.
          const result = await downloadAndInstall(githubReleaseId, {
            isStaged: (releaseId) => isAlreadyStaged(releaseId, getPendingUpdate()?.releaseId ?? null),
          });
          if (result.ok && result.releaseId && result.tag) await recordStaged({ tag: result.tag, releaseId: result.releaseId }).catch(() => null);
          if (!result.joined && !result.alreadyStaged) {
            db.logEvent({
              type: result.ok ? "update" : "error",
              entityType: "system",
              message: result.ok ? `Installed release "${result.releaseId}" — ready to activate` : `Install failed: ${result.message}`,
            });
          }
          return json(result, { status: result.ok ? 200 : 400 });
        } catch (err) {
          if (err instanceof UpdateBusyError) {
            // An activation holds the update slot. If it's the release the
            // user asked for, say so (the panel follows the activation);
            // otherwise it's a conflict.
            const a = err.activation;
            return json({ ok: false, activating: true, releaseId: a.releaseId, tag: a.tag, message: err.message }, { status: 409 });
          }
          db.logEvent({ type: "error", entityType: "system", message: `Update install failed: ${err instanceof Error ? err.message : String(err)}` });
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/update-now": {
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const { githubReleaseId, tag } = (await req.json()) as { githubReleaseId?: number; tag?: string };
          if (!githubReleaseId) return errorResponse("githubReleaseId is required");
          // Instant update: download → verify → activate in the background,
          // followed by the panel through /pending (job.instant + download +
          // activation) and the /internal/ready reconnect. Returns at once so
          // no request is left open when ShowFlow restarts.
          const result = await startInstantUpdateFor(githubReleaseId, tag ?? null, "manual");
          if (result.ok && !result.joined) {
            db.logEvent({ type: "update", entityType: "system", entityId: tag, message: `Instant update to ${tag ?? `release ${githubReleaseId}`} requested` });
          }
          const { done: _done, ...body } = result;
          return json({ ...body, accepted: result.ok, job: updateJobs.snapshot() }, { status: result.ok ? 202 : 409 });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/activate": {
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const { releaseId, tag, force } = (await req.json()) as { releaseId?: string; tag?: string; force?: boolean };
          if (!releaseId) return errorResponse("releaseId is required");
          db.logEvent({ type: "update", entityType: "system", message: `Activation requested for release "${releaseId}"${force ? " (skip drain)" : ""}` });
          // Drain → backup-if-migrating → handoff runs in the background (a
          // drain can take minutes, far past Bun's request idle timeout).
          // Progress is polled via /pending; once the handoff kills this
          // process the frontend's /internal/ready reconnect poll takes over.
          // The pending marker is NOT cleared on failure any more: clearing
          // it made the watcher re-download the same release next cycle.
          const pending = getPendingUpdate();
          const result = startActivation(releaseId, { tag: tag ?? (pending?.releaseId === releaseId ? pending.tag : null), force: !!force });
          return json({ ...result, accepted: result.ok }, { status: result.ok ? 202 : 409 });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/pending": {
      async GET(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        const pending = getPendingUpdate();
        // Only look up migrations when something is staged (one small file read).
        const migrations = pending ? await pendingMigrationsFor(pending.releaseId).catch(() => null) : null;
        return json({
          pending,
          autoDownload: isAutoDownloadEnabled(),
          autoActivate: getAutoActivate(),
          mode: getUpdateMode(),
          job: updateJobs.snapshot(),
          serverTime: new Date().toString(),
          download: getDownloadProgress(),
          downloadFailure: getDownloadFailure(),
          activation: getActivationProgress(),
          lastActivation: getLastActivation(),
          pendingMigrations: migrations ? migrations.map((m) => m.tag) : null,
          busy: currentBusy().map((b) => b.label),
        });
      },
    },

    "/api/admin/updates/check": {
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const body = (await req.json().catch(() => ({}))) as { force?: boolean };
          // Periodic visible-panel polls send force=false and lean on the
          // watcher's 15s feed TTL (still a cheap conditional GET → 304).
          // "Check now" sends force=true to bypass that and hit GitHub live.
          const result = await runWatchCycle({ force: body.force !== false });
          return json(result);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/settings": {
      async GET(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        return json({ autoDownload: isAutoDownloadEnabled(), autoActivate: getAutoActivate(), mode: getUpdateMode() });
      },
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const { autoDownload, autoActivate, mode } = (await req.json()) as { autoDownload?: boolean; autoActivate?: unknown; mode?: unknown };
          if (typeof autoDownload !== "boolean" && autoActivate === undefined && mode === undefined) {
            return errorResponse("autoDownload (boolean), autoActivate ({ mode, hour }) or mode (\"staged\" | \"instant\") is required");
          }
          if (mode !== undefined) {
            if (mode !== "staged" && mode !== "instant") return errorResponse('mode must be "staged" or "instant"');
            const next = setUpdateMode(mode);
            db.logEvent({ type: "update", entityType: "system", message: next === "instant" ? "Update mode: instant (download + activate in one go)" : "Update mode: staged (download, then activate)" });
          }
          if (typeof autoDownload === "boolean") {
            setAutoDownload(autoDownload);
            db.logEvent({ type: "update", entityType: "system", message: `Auto-download ${autoDownload ? "enabled" : "disabled"}` });
          }
          if (autoActivate !== undefined) {
            const next = setAutoActivate(normalizeAutoActivate(autoActivate));
            db.logEvent({
              type: "update",
              entityType: "system",
              message: next.mode === "off" ? "Auto-activate disabled" : next.mode === "idle" ? "Auto-activate when idle enabled" : `Auto-activate at ${String(next.hour).padStart(2, "0")}:00 (when idle) enabled`,
            });
          }
          return json({ ok: true, autoDownload: isAutoDownloadEnabled(), autoActivate: getAutoActivate(), mode: getUpdateMode() });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/admin/updates/status": {
      async GET(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const supervisor = await getSupervisorStatus();
          const current = await getCurrentRelease();
          return json({ ...supervisor, appReleaseId: BUILD_COMMIT, appVersion: current.display });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

  };
}
