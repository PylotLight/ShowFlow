import { LibraryIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";

function CompactLibrary({
  shows,
  onSelectShow,
  onBrowseLibrary,
}: {
  shows: ShowSummary[];
  onSelectShow: (show: ShowSummary) => void;
  onBrowseLibrary: () => void;
}) {
  const visible = shows.slice(0, 6);

  return (
    <GlassPanel className="flex flex-col overflow-hidden h-full">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2">
          <LibraryIcon className="size-4 text-signal" />
          <span className="font-display text-sm font-semibold tracking-wide">Library Preview</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onBrowseLibrary} className="text-muted-foreground h-7 px-2 text-xs">
          View All <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 p-3 overflow-y-auto scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
        {visible.length === 0 ? (
          <div className="text-muted-foreground py-10 text-center text-xs">No shows tracked yet.</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {visible.map((show) => (
              <button
                key={show.id}
                type="button"
                onClick={() => onSelectShow(show)}
                className="group flex items-center gap-3 rounded-lg border border-white/0 bg-white/[0.01] p-1.5 pr-3 text-left transition-all hover:border-white/5 hover:bg-white/[0.03]"
              >
                <PosterImage
                  showId={show.id}
                  alt={show.title}
                  className="h-12 w-9 shrink-0 rounded bg-white/5 object-cover shadow-sm transition-transform duration-200 group-hover:scale-105"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-xs font-semibold text-white transition-colors group-hover:text-signal">
                    {show.title}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-white/5 px-1 py-0.5 font-mono text-[7px] uppercase tracking-wider text-white/40">
                      {show.providerType}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}

export { CompactLibrary };
