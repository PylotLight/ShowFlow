import { CheckIcon, SearchIcon } from "lucide-react";
import * as React from "react";

import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { FileMedia } from "@frontend/components/showflow/EpisodeRow";
import { formatResolution } from "@frontend/lib/airtime";
import { cn } from "@frontend/lib/utils";

export type CompactEpisodeState = "available" | "awaiting" | "scheduled";

function sxe(season: number, episode: number) {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * Phone / mini-window episode row: poster thumb, one-line title with the
 * time pinned right, then a single meta line (SxxExx · state · resolution).
 * Replaces the desktop row's wrapping chip strip so a row is always two
 * short lines regardless of how long the show title is.
 */
export function CompactEpisodeRow({
  showId,
  showTitle,
  season,
  episode,
  episodeTitle,
  state,
  timeLabel,
  media,
  dim,
  onClick,
  onBrowse,
}: {
  showId?: string;
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle?: string;
  state: CompactEpisodeState;
  timeLabel?: string | null;
  media?: FileMedia | null;
  /** Past / history rows render slightly muted. */
  dim?: boolean;
  onClick?: () => void;
  /** Shown for episodes that aired but aren't on disk yet. */
  onBrowse?: () => void;
}) {
  const res = state === "available" && (media?.videoHeight != null || media?.videoWidth != null)
    ? formatResolution(media?.videoHeight ?? null, media?.videoWidth ?? null)
    : "";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && onClick) { e.preventDefault(); onClick(); } }}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-1.5 py-1.5 cursor-pointer transition-colors active:bg-white/[0.06] hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
        dim && "opacity-70",
      )}
    >
      {showId ? (
        <PosterImage
          showId={showId}
          alt={showTitle}
          size="card"
          className="w-8 h-12 shrink-0 rounded-md bg-white/5 object-cover ring-1 ring-white/5"
        />
      ) : (
        <div className="w-8 h-12 shrink-0 rounded-md bg-white/[0.03] ring-1 ring-white/5" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span title={showTitle} className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-white/90">
            {showTitle}
          </span>
          {timeLabel && (
            <span className="shrink-0 font-mono text-[11px] leading-none text-white/55">{timeLabel}</span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
          <span className="shrink-0 font-mono text-white/55">{sxe(season, episode)}</span>
          {state === "available" && (
            <span className="inline-flex shrink-0 items-center gap-0.5 font-mono font-semibold uppercase tracking-wide text-signal">
              <CheckIcon className="size-2.5" strokeWidth={3} /> Available
            </span>
          )}
          {state === "awaiting" && (
            <span
              title="Aired but not yet grabbed — check Pipeline or grab manually"
              className="shrink-0 font-mono font-semibold uppercase tracking-wide text-accent-amber"
            >
              Awaiting
            </span>
          )}
          {state === "scheduled" && (
            <span className="shrink-0 font-mono uppercase tracking-wide text-white/45">Scheduled</span>
          )}
          {res && <span className="shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[10px] text-white/65">{res}</span>}
          {episodeTitle && (
            <span className="min-w-0 truncate text-white/45" title={episodeTitle}>· {episodeTitle}</span>
          )}
        </div>
      </div>
      {onBrowse && (
        <button
          type="button"
          aria-label={`Browse releases for ${showTitle} ${sxe(season, episode)}`}
          title="Browse releases"
          onClick={(e) => { e.stopPropagation(); onBrowse(); }}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-white/55 hover:bg-signal/10 hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <SearchIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
