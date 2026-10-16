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
    <GlassPanel className="flex flex-col gap-1 p-5 max-md:gap-0.5 max-md:px-3.5 max-md:py-2.5">
      <span className="text-muted-foreground font-mono text-caption tracking-wider uppercase max-md:truncate max-md:text-[10px]">{label}</span>
      <span
        className={cn(
          "font-display text-3xl font-semibold tracking-wide max-md:text-2xl",
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
