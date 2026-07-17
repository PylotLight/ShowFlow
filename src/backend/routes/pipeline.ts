import { db } from "../db";
import { json, errorResponse } from "./_shared";

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
  };
}
