import { getDebugLogs, clearDebugLogs } from "../core/debug";
import { json } from "./_shared";

export function debugRoutes() {
  return {

    "/api/debug/logs": {
      GET(req: Request & { params: Record<string, string> }) {
        const url = new URL(req.url);
        const type = url.searchParams.get('type') || undefined;
        const level = url.searchParams.get('level') || undefined;
        const method = url.searchParams.get('method') || undefined;
        const path = url.searchParams.get('path') || undefined;
        const search = url.searchParams.get('search') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        const since = url.searchParams.get('since') || undefined;
        return json(getDebugLogs({ type: type as any, level: level as any, method, path, search, since, limit: Number.isNaN(limit) ? undefined : limit }));
      },
    },
    "/api/debug/clear": {
      POST() {
        clearDebugLogs();
        return json({ ok: true });
      },
    },
    "/api/debug/ws": {
      GET(req: Request & { params: Record<string, string> }, server: any) {
        if (server.upgrade(req)) return;
        return new Response("Upgrade failed", { status: 400 });
      },
    },

  };
}
