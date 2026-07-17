import { PauseIcon, PlayIcon, RadioIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Skeleton } from "@frontend/components/ui/skeleton";
import { cn } from "@frontend/lib/utils";

export interface ActivityEvent {
  id: number;
  type: string;
  message: string;
  timestamp: string;
}

function LiveDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-signal" />
    </span>
  );
}

function WatcherPanel({ onEvents, className }: { onEvents?: (events: ActivityEvent[]) => void; className?: string }) {
  const [watching, setWatching] = React.useState<boolean | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const prevCountRef = React.useRef(0);

  const refresh = React.useCallback(() => {
    fetch("/api/system/status")
      .then((r) => r.json())
      .then((d) => setWatching(d.watching))
      .catch(() => setWatching(null));

    fetch("/api/events?limit=50")
      .then((r) => r.json())
      .then((data: ActivityEvent[]) => {
        setEvents(data);
        onEvents?.(data);
      })
      .catch(() => setEvents([]));
  }, [onEvents]);

  React.useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Auto-scroll to latest event when new ones arrive
  React.useEffect(() => {
    if (events && events.length > prevCountRef.current && listRef.current) {
      listRef.current.scrollTop = 0;
    }
    prevCountRef.current = events?.length ?? 0;
  }, [events]);

  async function toggle() {
    setBusy(true);
    try {
      await fetch(watching ? "/api/system/watch/stop" : "/api/system/watch/start", { method: "POST" });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const isLive = watching && events && events.length > 0 && Date.now() - new Date(events[0]!.timestamp).getTime() < 120_000;

  return (
    <GlassPanel className={cn("flex flex-col gap-4 p-5 min-h-0 overflow-hidden", className)}>
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative flex items-center justify-center">
            <RadioIcon className={cn("size-4 z-10", watching ? "text-signal" : "text-muted-foreground")} />
            {watching && (
              <span className="absolute inset-0 size-4 rounded-full bg-signal/15 animate-ping" />
            )}
          </div>
          <div>
            <span className="font-display text-sm font-semibold tracking-wide block">Live Events</span>
            <div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground mt-0.5">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  watching ? "bg-signal animate-pulse-glow" : "bg-white/25",
                )}
              />
              {watching === null ? "CHECKING STATUS" : watching ? "ACTIVE & WATCHING" : "SERVICE IDLE"}
              {isLive && (
                <>
                  <span className="text-white/20">·</span>
                  <span className="text-signal font-bold tracking-wider flex items-center gap-1">
                    <LiveDot />
                    LIVE
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <Button 
          variant={watching ? "destructive" : "outline"} 
          size="sm" 
          onClick={toggle} 
          disabled={busy || watching === null}
          className="h-8 font-mono text-caption uppercase tracking-wider transition-all duration-200 hover:scale-105 active:scale-95"
        >
          {watching ? <PauseIcon className="size-3.5 mr-1" /> : <PlayIcon className="size-3.5 mr-1" />}
          {watching ? "Stop" : "Start"}
        </Button>
      </div>

      <div ref={listRef} className="flex flex-col-reverse divide-y divide-white/5 border-t border-white/5 pt-1 overflow-y-auto flex-1 min-h-0 scrollbar-thin scrollbar-thumb-white/5 scrollbar-track-transparent">
        {events === null ? (
          <div className="flex flex-col gap-2 py-3 px-1">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-4 w-10 rounded shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <span className="text-muted-foreground py-3 text-center text-xs font-mono">NO ACTIVITY LOGGED.</span>
        ) : (
          events.map((e) => {
            let badgeClass = "bg-white/5 text-white/60";
            let badgeLabel = e.type || "info";
            const timeAgo = Date.now() - new Date(e.timestamp).getTime();
            const isRecent = timeAgo < 30_000;

            if (e.type === "grab") {
              badgeClass = "bg-signal/15 text-signal font-semibold border border-signal/10";
              badgeLabel = "grab";
            } else if (e.type === "error") {
              badgeClass = "bg-destructive/15 text-destructive font-semibold border border-destructive/10";
              badgeLabel = "error";
            } else if (e.type === "import" || e.message.toLowerCase().includes("import") || e.message.toLowerCase().includes("completed")) {
              badgeClass = "bg-accent-amber/15 text-accent-amber font-semibold border border-accent-amber/10";
              badgeLabel = "import";
            } else if (e.type === "scan") {
              badgeClass = "bg-blue-500/15 text-blue-400 font-semibold border border-blue-500/10";
              badgeLabel = "scan";
            } else if (e.type === "watcher") {
              badgeClass = "bg-purple-500/15 text-purple-400 font-semibold border border-purple-500/10";
              badgeLabel = "watcher";
            } else if (e.type === "upgrade") {
              badgeClass = "bg-green-500/15 text-green-400 font-semibold border border-green-500/10";
              badgeLabel = "upgrade";
            } else if (e.type === "skip") {
              badgeClass = "bg-gray-500/15 text-gray-400 font-semibold border border-gray-500/10";
              badgeLabel = "skip";
            } else if (e.type === "dryrun") {
              badgeClass = "bg-yellow-500/15 text-yellow-400 font-semibold border border-yellow-500/10";
              badgeLabel = "dryrun";
            } else if (e.type === "delete") {
              badgeClass = "bg-red-500/15 text-red-400 font-semibold border border-red-500/10";
              badgeLabel = "delete";
            }

            return (
              <div key={e.id} className={cn(
                "flex items-start gap-3 py-2.5 px-1 rounded transition-colors",
                isRecent ? "bg-signal/[0.02]" : "hover:bg-white/[0.01]",
              )}>
                <span className={cn("rounded px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-wider shrink-0 mt-0.5", badgeClass)}>
                  {badgeLabel}
                </span>
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <span className="text-xs text-white/90 break-words leading-normal font-sans">{e.message}</span>
                  <span className="text-muted-foreground font-mono text-[9px] tracking-tight flex items-center gap-1.5">
                    {new Date(e.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    {isRecent && <span className="size-1 rounded-full bg-signal/60" />}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </GlassPanel>
  );
}

export { WatcherPanel };
