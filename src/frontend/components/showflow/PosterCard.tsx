import * as React from "react";

import { cn } from "@frontend/lib/utils";
import { PosterImage } from "@frontend/components/showflow/PosterImage";

export interface ShowSummary {
  id: string;
  providerType: string;
  title: string;
  profile?: string;
  seriesType?: string;
  trackedCount?: number;
  grabbedCount?: number;
  addedAt?: string;
  lastUpdated?: string;
}

function PosterCard({
  show,
  selected,
  onClick,
  showProvider = true,
  showStats = true,
}: {
  show: ShowSummary;
  selected?: boolean;
  onClick?: () => void;
  showProvider?: boolean;
  showStats?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative aspect-2/3 w-full overflow-hidden rounded-lg text-left outline-none",
        "ring-1 ring-white/10 transition-all duration-200 hover:-translate-y-1 hover:ring-white/25 hover:shadow-[0_12px_30px_-8px_oklch(0_0_0/0.6)]",
        "focus-visible:ring-2 focus-visible:ring-signal",
        selected && "ring-2 ring-signal",
      )}
    >
      <PosterImage showId={show.id} alt={show.title} className="size-full" />

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent opacity-90 transition-opacity group-hover:opacity-100" />

      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3">
        <span className="font-display text-base leading-tight font-semibold tracking-wide text-white drop-shadow-sm">
          {show.title}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          {showProvider && (
            <span className="font-mono text-caption uppercase tracking-wider text-white/50">{show.providerType}</span>
          )}
          {showStats && (show.trackedCount !== undefined || show.grabbedCount !== undefined) && (
            <div className="flex items-center gap-1.5">
              {(show.trackedCount || 0) > 0 && (
                <span className="font-mono text-[10px] uppercase tracking-wider text-signal bg-signal/10 px-1 rounded">
                  {show.trackedCount} tracked
                </span>
              )}
              {(show.grabbedCount || 0) > 0 && (
                <span className="font-mono text-[10px] uppercase tracking-wider text-green-400 bg-green-400/10 px-1 rounded">
                  {show.grabbedCount} grabbed
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export { PosterCard };
