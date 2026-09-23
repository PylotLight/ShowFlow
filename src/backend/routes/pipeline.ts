import { db } from "../db";
import { json, errorResponse, toIsoUtc } from "./_shared";

const STAGE_ORDER = ["WANTED", "SEARCHING", "GRABBED", "IMPORTING", "FAILED", "AVAILABLE"];

const STAGE_LABELS: Record<string, string> = {
  WANTED: "Wanted",
  SEARCHING: "Searching",
  GRABBED: "Grabbed",
  IMPORTING: "Importing",
  FAILED: "Failed",
  AVAILABLE: "Available",
};

export function pipelineRoutes() {
  return {
    "/api/pipeline/kanban": {
      async GET() {
        try {
          const episodes = db.listKanbanEpisodes();

          // Group into lanes by effective stage
          const laneMap = new Map<string, typeof episodes>();
          for (const ep of episodes) {
            const stage = ep.currentStage;
            if (!laneMap.has(stage)) laneMap.set(stage, []);
            laneMap.get(stage)!.push(ep);
          }

          const lanes = STAGE_ORDER
            .filter(stage => laneMap.has(stage))
            .map(stage => ({
              stage,
              label: STAGE_LABELS[stage] ?? stage,
              items: laneMap.get(stage)!,
              count: laneMap.get(stage)!.length,
            }));

          const total = episodes.length;
          const attentionCount = lanes
            .filter(l => l.stage === "WANTED" || l.stage === "SEARCHING" || l.stage === "FAILED")
            .reduce((sum, l) => sum + l.count, 0);

          return json({ lanes, total, attentionCount });
        } catch (err) {
          console.error("[pipeline/kanban]", err);
          return errorResponse(err, 500);
        }
      },
    },
    "/api/history": {
      async GET(req: Request) {
        try {
          const url = new URL(req.url);
          const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
          const showId = url.searchParams.get("showId")?.trim() || undefined;
          const kindRaw = url.searchParams.get("kind")?.trim();
          const kind = kindRaw === "grab" || kindRaw === "import" || kindRaw === "event" ? kindRaw : undefined;
          const q = url.searchParams.get("q")?.trim() || undefined;
          const { items, hasMore } = db.listHistory({
            limit: Number.isNaN(limitRaw) ? 50 : limitRaw,
            offset: Number.isNaN(offsetRaw) ? 0 : offsetRaw,
            showId,
            kind,
            query: q,
          });
          return json({
            items: items.map((it) => ({ ...it, timestamp: toIsoUtc(it.timestamp) })),
            hasMore,
          });
        } catch (err) {
          console.error("[pipeline/history]", err);
          return errorResponse(err, 500);
        }
      },
    },
  };
}
