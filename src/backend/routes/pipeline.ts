import { db } from "../db";
import { json, errorResponse, toIsoUtc } from "./_shared";
import {
  buildLiveIndex,
  explainEpisodes,
  getPipelineSummary,
  listAttention,
  listKanbanEpisodes,
  type LiveDownload,
} from "../core/pipeline/explain";

const STAGE_ORDER = ["WANTED", "SEARCHING", "GRABBED", "IMPORTING", "FAILED", "AVAILABLE"];

const STAGE_LABELS: Record<string, string> = {
  WANTED: "Wanted",
  SEARCHING: "Searching",
  GRABBED: "Grabbed",
  IMPORTING: "Importing",
  FAILED: "Failed",
  AVAILABLE: "Available",
};

/** Anything that can list in-flight downloads (SystemManager / DownloadManager). */
export interface LiveDownloadSource {
  getProcessingDetail(): { client: string; title: string; state: string; progress: number | null }[];
}

/**
 * Episode id for /api/episodes/:id/explain: `<showId>:<season>:<episode>`
 * (url-encoded; show ids are uuids so `-` can't be the separator).
 */
export function parseEpisodeId(id: string): { showId: string; season: number; episode: number } | null {
  const decoded = decodeURIComponent(id);
  const m = decoded.match(/^(.+):(\d+):(\d+)$/);
  if (!m) return null;
  return { showId: m[1]!, season: parseInt(m[2]!, 10), episode: parseInt(m[3]!, 10) };
}

export function pipelineRoutes(liveSource?: LiveDownloadSource) {
  // Live TorBox progress is in memory on the download client - cheap to read
  // per request, mapped to episodes with one grabs query.
  const liveIndex = () => {
    try {
      const live: LiveDownload[] = (liveSource?.getProcessingDetail() ?? [])
        .filter(d => d.client === "torbox")
        .map(d => ({ title: d.title, state: d.state, progress: d.progress }));
      return buildLiveIndex(db, live);
    } catch {
      return new Map();
    }
  };

  return {
    // Legacy lanes. AVAILABLE is dropped unless ?includeAvailable=1 (it was
    // ~1600 on-disk episodes re-sent every poll); lanes now come from the
    // same explain() as the attention list instead of the newest event row.
    "/api/pipeline/kanban": {
      async GET(req: Request) {
        try {
          const url = new URL(req.url);
          const includeAvailable = url.searchParams.get("includeAvailable") === "1";
          const episodes = listKanbanEpisodes(db, { includeAvailable, live: liveIndex() });

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

          const total = episodes.filter(e => e.currentStage !== "AVAILABLE").length;
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
    // "Needs attention": every not-done episode with a plain-English reason,
    // oldest wait first. ?limit=&offset=&showId=
    "/api/pipeline/attention": {
      async GET(req: Request) {
        try {
          const url = new URL(req.url);
          const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10);
          const showId = url.searchParams.get("showId")?.trim() || undefined;
          const page = listAttention(db, {
            limit: Number.isNaN(limitRaw) ? 50 : limitRaw,
            offset: Number.isNaN(offsetRaw) ? 0 : offsetRaw,
            showId,
            live: liveIndex(),
          });
          return json(page);
        } catch (err) {
          console.error("[pipeline/attention]", err);
          return errorResponse(err, 500);
        }
      },
    },
    "/api/episodes/:id/explain": {
      async GET(req: Request & { params: { id: string } }) {
        try {
          const key = parseEpisodeId(req.params.id);
          if (!key) return json({ error: "Episode id must be <showId>:<season>:<episode>" }, { status: 400 });
          const [item] = explainEpisodes(
            db,
            { pipelineOnly: false, showId: key.showId, season: key.season, episode: key.episode },
            { live: liveIndex() },
          ).filter(e => e.season === key.season && e.episode === key.episode);
          if (!item) return json({ error: "Episode not found" }, { status: 404 });
          return json(item);
        } catch (err) {
          console.error("[episodes/explain]", err);
          return errorResponse(err, 500);
        }
      },
    },
    // Counts-only endpoint for badge polling (Sidebar, every 15s). Same
    // numbers as /api/pipeline/kanban's total/attentionCount plus the
    // attention-list size and per-state counts.
    "/api/pipeline/summary": {
      async GET() {
        try {
          const { total, attentionCount, needsAttention, byState } = getPipelineSummary(db);
          const showCount = db.countShows();
          return json({ total, attentionCount, needsAttention, byState, showCount });
        } catch (err) {
          console.error("[pipeline/summary]", err);
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
