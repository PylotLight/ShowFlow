import * as React from "react";
import { CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "@frontend/lib/utils";

interface LibraryHealthProps {
  seriesCount: number;
  className?: string;
}

export function LibraryHealth({ seriesCount, className }: LibraryHealthProps) {
  // Mock check state for demonstration of exceptions vs healthy strip
  const [issues, setIssues] = React.useState<string[]>([]);
  const [lastChecked, setLastChecked] = React.useState("2 minutes ago");

  // In a real application, you'd fetch anomalies like failed downloads or storage warnings from the backend
  React.useEffect(() => {
    // Optionally fetch health/exceptions from a system endpoint
  }, []);

  const isHealthy = issues.length === 0;

  return (
    <div
      className={cn(
        "glass-panel flex items-center justify-between px-4 py-3 text-xs transition-all duration-200",
        isHealthy ? "border-emerald-500/10 bg-emerald-950/5" : "border-amber-500/15 bg-amber-950/5",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {isHealthy ? (
          <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 text-amber-500 shrink-0" />
        )}
        <span className="font-medium text-white/95">
          {isHealthy ? (
            <>
              Library healthy <span className="text-white/40 mx-1.5 font-mono">·</span> {seriesCount} series{" "}
              <span className="text-white/40 mx-1.5 font-mono">·</span> Last verified {lastChecked}
            </>
          ) : (
            `Library warning: ${issues.join(", ")}`
          )}
        </span>
      </div>

      <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest hidden sm:block">
        // HEALTH CHECK OK
      </div>
    </div>
  );
}
