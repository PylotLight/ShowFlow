import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

export type LibraryFilter = { providerType: string | null; profile: string | null };

function FilterRail({
  shows,
  filter,
  onChange,
}: {
  shows: ShowSummary[];
  filter: LibraryFilter;
  onChange: (f: LibraryFilter) => void;
}) {
  const providerTypes = React.useMemo(() => {
    const set = new Set(shows.map((s) => s.providerType));
    return Array.from(set).sort();
  }, [shows]);

  const profiles = React.useMemo(() => {
    const set = new Set(shows.map((s) => s.profile).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [shows]);

  return (
    <aside className="sticky top-8 flex h-fit w-48 shrink-0 flex-col gap-6">
      <GlassPanel className="flex flex-col gap-2 p-4">
        <span className="font-display text-xs font-semibold tracking-wider text-white/50 uppercase">Provider</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onChange({ ...filter, providerType: null })}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-sub font-medium tracking-wide transition-colors",
              filter.providerType === null
                ? "bg-signal text-signal-foreground"
                : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80",
            )}
          >
            All
          </button>
          {providerTypes.map((pt) => (
            <button
              key={pt}
              type="button"
              onClick={() => onChange({ ...filter, providerType: pt })}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-sub font-medium tracking-wide transition-colors",
                filter.providerType === pt
                  ? "bg-signal text-signal-foreground"
                  : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80",
              )}
            >
              {pt}
            </button>
          ))}
        </div>
      </GlassPanel>

      {profiles.length > 0 && (
        <GlassPanel className="flex flex-col gap-2 p-4">
          <span className="font-display text-xs font-semibold tracking-wider text-white/50 uppercase">Profile</span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onChange({ ...filter, profile: null })}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-sub font-medium tracking-wide transition-colors",
                filter.profile === null
                  ? "bg-signal text-signal-foreground"
                  : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80",
              )}
            >
              All
            </button>
            {profiles.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange({ ...filter, profile: p })}
                className={cn(
                  "rounded-md px-2.5 py-1 font-mono text-sub font-medium tracking-wide transition-colors",
                  filter.profile === p
                    ? "bg-signal text-signal-foreground"
                    : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80",
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </GlassPanel>
      )}
    </aside>
  );
}

export { FilterRail };
