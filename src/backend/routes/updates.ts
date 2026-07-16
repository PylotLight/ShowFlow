import { db } from "../db";
import { listReleases, downloadAndInstall, triggerActivate, getSupervisorStatus } from "../core/updates_manager";
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
          const result = await listReleases(BUILD_VERSION, page);
          return json({ current: { releaseId: BUILD_COMMIT, version: BUILD_VERSION }, ...result });
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
          const result = await downloadAndInstall(githubReleaseId);
          db.logEvent({
            type: result.ok ? "update" : "error",
            entityType: "system",
            message: result.ok ? `Installed release "${result.releaseId}" — ready to activate` : `Install failed: ${result.message}`,
          });
          return json(result, { status: result.ok ? 200 : 400 });
        } catch (err) {
          db.logEvent({ type: "error", entityType: "system", message: `Update install failed: ${err instanceof Error ? err.message : String(err)}` });
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/activate": {
      async POST(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const { releaseId } = (await req.json()) as { releaseId?: string };
          if (!releaseId) return errorResponse("releaseId is required");
          db.logEvent({ type: "update", entityType: "system", message: `Activation triggered for release "${releaseId}"` });
          const result = await triggerActivate(releaseId);
          return json(result, { status: result.ok ? 200 : 400 });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/admin/updates/status": {
      async GET(req: Request & { params: Record<string, string> }) {
        if (!checkAdminAuth(req)) return unauthorized();
        try {
          const supervisor = await getSupervisorStatus();
          return json({ ...supervisor, appReleaseId: BUILD_COMMIT, appVersion: BUILD_VERSION });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

  };
}
