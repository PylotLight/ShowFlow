import { db } from "../db";
import { json, errorResponse, toIsoUtc } from "./_shared";
import { markReleaseFailed } from "../core/release_failures";

type ParamReq = Request & { params: Record<string, string> };

function parseId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Failed-download handling + release blocklist (see core/release_failures.ts).
 *   GET    /api/grabs?limit=        recent grabs with lifecycle status
 *   POST   /api/grabs/:id/fail      mark a grab failed + blocklist its release
 *   GET    /api/blocklist           blocklisted releases
 *   DELETE /api/blocklist           clear the whole blocklist
 *   DELETE /api/blocklist/:id       un-blocklist one release
 */
export function blocklistRoutes() {
  return {
    "/api/grabs": {
      async GET(req: Request) {
        try {
          const limit = parseInt(new URL(req.url).searchParams.get("limit") ?? "50", 10);
          const rows = db.listRecentGrabs(Number.isNaN(limit) ? 50 : limit);
          return json({
            items: rows.map((r) => ({
              id: r.id,
              showId: r.show_id,
              showTitle: r.show_title,
              seasonNumber: r.season_number,
              episodeNumber: r.episode_number,
              releaseTitle: r.release_title,
              indexerName: r.indexer_name,
              status: r.status,
              failureReason: r.failure_reason,
              grabbedAt: r.grabbed_at ? toIsoUtc(r.grabbed_at) : null,
              failedAt: r.failed_at ? toIsoUtc(r.failed_at) : null,
            })),
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/grabs/:id/fail": {
      async POST(req: ParamReq) {
        try {
          const id = parseId(req.params.id);
          if (!id) return json({ error: "invalid grab id" }, { status: 400 });
          let reason = "marked failed by user";
          try {
            const body = (await req.json()) as { reason?: unknown };
            if (typeof body?.reason === "string" && body.reason.trim()) reason = body.reason.trim().slice(0, 300);
          } catch { /* empty body is fine */ }
          const res = markReleaseFailed({ grabId: id, reason, source: "manual" });
          if (!res) return json({ error: "grab not found" }, { status: 404 });
          return json({ success: true, ...res });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/blocklist": {
      async GET(req: Request) {
        try {
          const limit = parseInt(new URL(req.url).searchParams.get("limit") ?? "200", 10);
          const rows = db.listBlocklist(Number.isNaN(limit) ? 200 : limit);
          return json({
            items: rows.map((r) => ({
              id: r.id,
              showId: r.show_id,
              showTitle: r.show_title,
              seasonNumber: r.season_number,
              episodeNumbers: r.episode_numbers ? (JSON.parse(r.episode_numbers) as number[]) : [],
              releaseTitle: r.release_title,
              infoHash: r.info_hash,
              indexerName: r.indexer_name,
              reason: r.reason,
              createdAt: toIsoUtc(r.created_at),
            })),
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async DELETE() {
        try {
          return json({ success: true, removed: db.clearBlocklist() });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
    "/api/blocklist/:id": {
      async DELETE(req: ParamReq) {
        try {
          const id = parseId(req.params.id);
          if (!id) return json({ error: "invalid blocklist id" }, { status: 400 });
          const ok = db.removeFromBlocklist(id);
          return ok ? json({ success: true }) : json({ error: "not found" }, { status: 404 });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
