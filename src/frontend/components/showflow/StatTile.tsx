import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { cn } from "@frontend/lib/utils";

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: "signal" | "amber";
}) {
  return (
    <GlassPanel className="flex flex-col gap-1 p-5">
      <span className="text-muted-foreground font-mono text-caption tracking-wider uppercase">{label}</span>
      <span
        className={cn(
          "font-display text-3xl font-semibold tracking-wide",
          accent === "signal" && "text-signal",
          accent === "amber" && "text-accent-amber",
        )}
      >
        {value}
      </span>
    </GlassPanel>
  );
}

export { StatTile };
