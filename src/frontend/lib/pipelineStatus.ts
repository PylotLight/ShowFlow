/**
 * Client side of core/pipeline/explain.ts: the per-episode "why hasn't
 * this been pulled" answer, plus chip labels/colors shared by the Pipeline
 * attention list and the ShowDetail episode-row badge.
 */

export type ExplainState =
  | "not_tracked"
  | "manual_only"
  | "waiting_air"
  | "waiting_release_delay"
  | "searching"
  | "not_found"
  | "grabbed_downloading"
  | "importing"
  | "stuck"
  | "done";

export type ExplainAction = "search_now" | "open_show" | "change_search_mode" | "retry" | null;

export interface ExplainedEpisode {
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle: string | null;
  airDate: string | null;
  searchMode: string;
  filePath: string | null;
  isMovie: boolean;
  state: ExplainState;
  blocker: string | null;
  detail: string;
  nextCheckAt: string | null;
  action: ExplainAction;
  waitingSince: string | null;
  dueNow: boolean;
  attempts: number;
  lastSearchedAt: string | null;
  progress: number | null;
  releaseTitle: string | null;
}

export interface AttentionPage {
  items: ExplainedEpisode[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export const STATE_LABEL: Record<ExplainState, string> = {
  not_tracked: "Not monitored",
  manual_only: "Manual",
  waiting_air: "Upcoming",
  waiting_release_delay: "Release delay",
  searching: "Searching",
  not_found: "Not found",
  grabbed_downloading: "Downloading",
  importing: "Importing",
  stuck: "Stuck",
  done: "On disk",
};

/** Chip classes: tinted bg + readable (non-faded) text. */
export const STATE_CHIP: Record<ExplainState, string> = {
  not_tracked: "bg-white/[0.06] border-white/10 text-muted-foreground",
  manual_only: "bg-accent-amber/15 border-accent-amber/25 text-accent-amber",
  waiting_air: "bg-white/[0.06] border-white/10 text-foreground/80",
  waiting_release_delay: "bg-white/[0.06] border-white/10 text-foreground/80",
  searching: "bg-blue-500/15 border-blue-500/25 text-blue-300",
  not_found: "bg-orange-500/15 border-orange-500/25 text-orange-300",
  grabbed_downloading: "bg-purple-500/15 border-purple-500/25 text-purple-300",
  importing: "bg-accent-amber/15 border-accent-amber/25 text-accent-amber",
  stuck: "bg-destructive/15 border-destructive/30 text-red-300",
  done: "bg-emerald-500/15 border-emerald-500/25 text-emerald-300",
};

export const ACTION_LABEL: Record<Exclude<ExplainAction, null>, string> = {
  search_now: "Search now",
  retry: "Retry",
  open_show: "Open show",
  change_search_mode: "Set to auto",
};

export function episodeExplainId(showId: string, season: number, episode: number): string {
  return encodeURIComponent(`${showId}:${season}:${episode}`);
}

export function epCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** "3d", "5h", "12m" - how long something has been waiting. */
export function formatAge(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Fire the episode's one-click action. Returns a user-facing result line. */
export async function runExplainAction(
  item: Pick<ExplainedEpisode, "showId" | "season" | "episode" | "isMovie" | "action">,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (item.action === "change_search_mode") {
      const res = await fetch(`/api/shows/${encodeURIComponent(item.showId)}/seasons/${item.season}/episodes/${item.episode}/search`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      });
      return res.ok ? { ok: true, message: "Search mode set to auto" } : { ok: false, message: "Couldn't change search mode" };
    }
    if (item.action === "search_now" || item.action === "retry") {
      const url = item.isMovie
        ? `/api/shows/${encodeURIComponent(item.showId)}/movie/grab`
        : `/api/shows/${encodeURIComponent(item.showId)}/seasons/${item.season}/episodes/${item.episode}/grab`;
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      const ok = !!body.success;
      return { ok, message: body.message || (ok ? "Grabbed" : "No matching release found") };
    }
    return { ok: false, message: "Nothing to do" };
  } catch {
    return { ok: false, message: "Request failed — check your connection" };
  }
}
