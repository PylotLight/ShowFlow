import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { usePolling, setIfChanged } from "@frontend/lib/usePolling";

interface CutoffEpisode {
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
  currentQuality: string | null;
  cutoff: string;
  profile: string;
  lastSearchedAt: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const SHOWN = 50;

/**
 * Dashboard strip for Wanted > Cutoff unmet (GET /api/wanted/cutoff):
 * episodes whose file is below their quality profile's cutoff and that the
 * auto-grabber keeps upgrading a few at a time. Hidden when there are none.
 */
export function CutoffUnmetBanner({ onOpenShow }: { onOpenShow: (showId: string) => void }) {
  const [data, setData] = React.useState<{ count: number; episodes: CutoffEpisode[] } | null>(null);
  const [open, setOpen] = React.useState(false);

  usePolling(() => {
    const update = setIfChanged(setData);
    fetch(`/api/wanted/cutoff?limit=${SHOWN}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(update)
      .catch(() => {});
  }, 5 * 60_000);

  if (!data || data.count === 0) return null;

  return (
    <div className="glass-panel rounded-xl border-accent-amber/15 shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
      >
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-bold uppercase tracking-wider text-accent-amber">Cutoff unmet</span>
        <span className="text-sm text-white">
          {data.count} episode{data.count !== 1 && "s"} below their quality cutoff
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">· upgraded a few per auto-grab cycle</span>
        <span className="flex-1" />
        {open ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
      </button>
      {open && (
        <ul className="max-h-64 overflow-y-auto border-t border-white/5 px-3 py-2">
          {data.episodes.map((ep) => (
            <li key={`${ep.showId}-${ep.season}-${ep.episode}`}>
              <button
                type="button"
                onClick={() => onOpenShow(ep.showId)}
                className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-left hover:bg-white/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
              >
                <span className="text-xs font-medium text-white/80">{ep.showTitle}</span>
                <span className="font-mono text-[11px] text-white/60">S{pad(ep.season)}E{pad(ep.episode)}</span>
                <span className="flex-1" />
                <span className="font-mono text-[11px] text-white/70">
                  {ep.currentQuality ?? "unknown"} → {ep.cutoff}
                </span>
              </button>
            </li>
          ))}
          {data.count > data.episodes.length && (
            <li className="px-2 py-1 font-mono text-[11px] text-white/60">+{data.count - data.episodes.length} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
