import * as React from "react";

import { cn } from "@frontend/lib/utils";

export interface TickerItem {
  key: string;
  label: string;
  tone?: "signal" | "amber" | "muted";
}

/**
 * Broadcast-style ticker tape, pinned to the bottom of the dashboard. The
 * item list is duplicated once so the CSS marquee loops seamlessly - keep
 * the source list short (~10-15 items) or the loop gets noticeably long.
 */
function EventTicker({ items }: { items: TickerItem[] }) {
  if (items.length === 0) {
    return (
      <div className="glass-panel fixed inset-x-0 bottom-0 z-30 flex h-9 items-center rounded-none border-x-0 border-b-0 px-4">
        <span className="text-muted-foreground font-mono text-xs">No recent activity.</span>
      </div>
    );
  }

  return (
    <div className="glass-panel fixed inset-x-0 bottom-0 z-30 h-9 overflow-hidden rounded-none border-x-0 border-b-0">
      <div className="animate-ticker flex h-full w-max items-center gap-10 px-4 whitespace-nowrap">
        {[...items, ...items].map((item, i) => (
          <span
            key={`${item.key}-${i}`}
            className={cn("flex items-center gap-2 font-mono text-xs", toneClass(item.tone))}
          >
            <span aria-hidden className="size-1 shrink-0 rounded-full bg-current" />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function toneClass(tone?: TickerItem["tone"]) {
  if (tone === "signal") return "text-signal";
  if (tone === "amber") return "text-accent-amber";
  return "text-muted-foreground";
}

export { EventTicker };
