import * as React from "react";
import { ChevronDown, ChevronRight, Loader2Icon } from "lucide-react";

import { navigate } from "@frontend/lib/router";

interface CutoffEpisode {
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
  currentQuality: string | null;
  cutoff: string;
  upgradeMisses: number;
  givenUp: "misses" | "aged" | null;
}

interface CutoffResponse {
  count: number;
  givenUp: number;
  policy: { misses: number; days: number };
  episodes: CutoffEpisode[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const SHOWN = 200;

/**
 * Collapsed "episodes below this cutoff" view for one quality profile (GET
 * /api/wanted/cutoff?profile=). Lives in the profile's Upgrades section, next
 * to the setting it depends on - deliberately not on the Dashboard. Nothing
 * is fetched until it's opened (scoring every file isn't free).
 */
export function CutoffUnmetList({ profileId, dirty }: { profileId: string; dirty: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<CutoffResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/wanted/cutoff?profile=${encodeURIComponent(profileId)}&includeGivenUp=1&limit=${SHOWN}`)
      .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<CutoffResponse>; })
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [profileId]);

  // Profile switched or saved: drop the stale list, reload if it's open.
  React.useEffect(() => { setData(null); if (open) load(); }, [profileId, load]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading) load();
  }

  const reason = (ep: CutoffEpisode) =>
    ep.givenUp === "misses" ? `gave up after ${ep.upgradeMisses} searches`
      : ep.givenUp === "aged" ? `aired over ${data?.policy.days ?? 0} days ago`
        : ep.upgradeMisses ? `${ep.upgradeMisses} ${ep.upgradeMisses === 1 ? "search" : "searches"} so far` : "not searched yet";

  return (
    <div className="rounded-lg border border-white/[0.08]">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sub outline-none hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-signal/70"
      >
        {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        <span className="text-foreground/90">Episodes below this cutoff</span>
        {data && (
          <span className="text-caption text-muted-foreground">
            {data.count} being upgraded{data.givenUp ? ` · ${data.givenUp} given up` : ""}
          </span>
        )}
        <span className="flex-1" />
        {loading && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
      </button>
      {open && (
        <div className="border-t border-white/[0.06] px-3 py-2">
          {dirty && <p className="pb-1 text-caption text-amber-200">Showing the saved profile. Save to see your changes.</p>}
          {error && <p role="alert" className="text-caption text-red-300">Couldn't load: {error}</p>}
          {data && data.episodes.length === 0 && <p className="text-caption text-muted-foreground">Every file meets this cutoff.</p>}
          {data && data.episodes.length > 0 && (
            <ul className="max-h-64 overflow-y-auto">
              {data.episodes.map(ep => (
                <li key={`${ep.showId}-${ep.season}-${ep.episode}`}>
                  <button
                    type="button"
                    onClick={() => navigate(`#/show/${encodeURIComponent(ep.showId)}`)}
                    className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1 text-left outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-signal/70"
                  >
                    <span className="text-caption font-medium text-foreground/85">{ep.showTitle}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">S{pad(ep.season)}E{pad(ep.episode)}</span>
                    <span className="flex-1" />
                    <span className={ep.givenUp ? "text-[11px] text-muted-foreground/70" : "text-[11px] text-muted-foreground"}>{reason(ep)}</span>
                    <span className="font-mono text-[11px] text-foreground/70">{ep.currentQuality ?? "unknown"} → {ep.cutoff}</span>
                  </button>
                </li>
              ))}
              {data.count + data.givenUp > data.episodes.length && (
                <li className="px-1.5 py-1 font-mono text-[11px] text-muted-foreground">+{data.count + data.givenUp - data.episodes.length} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
