import * as React from "react";

import { cn } from "@frontend/lib/utils";

export type EpisodeChipState = "tracked" | "airing" | "none";

const DOT_STYLES: Record<EpisodeChipState, string> = {
  tracked: "bg-signal shadow-[0_0_6px_var(--signal)]",
  airing: "bg-accent-amber shadow-[0_0_6px_var(--accent-amber)]",
  none: "bg-white/20",
};

/**
 * The signature element - a tally-light dot + mono timecode. This same
 * shape repeats in the library grid, season tabs, and episode rows so the
 * "control room" language stays consistent everywhere an episode shows up.
 */
function EpisodeChip({
  season,
  episode,
  state = "none",
  className,
}: {
  season: number;
  episode: number;
  state?: EpisodeChipState;
  className?: string;
}) {
  const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return (
    <span
      data-slot="episode-chip"
      className={cn("inline-flex items-center gap-1.5 font-mono text-xs tabular-nums", className)}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full transition-colors", DOT_STYLES[state])} />
      {code}
    </span>
  );
}

export { EpisodeChip };
