import { FileIcon, Loader2Icon, PauseIcon, PlayIcon, RadioIcon, RefreshCwIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { StatTile } from "@frontend/components/showflow/StatTile";
import { cn } from "@frontend/lib/utils";

interface ActivityEvent {
  id: number;
  type: string;
  message: string;
  timestamp: string;
}

const EVENT_BADGES: Record<string, string> = {
  grab: "bg-signal/15 text-signal font-semibold border border-signal/10",
  download: "bg-purple-500/15 text-purple-400 font-semibold border border-purple-500/10",
  error: "bg-destructive/15 text-destructive font-semibold border border-destructive/10",
  import: "bg-accent-amber/15 text-accent-amber font-semibold border border-accent-amber/10",
  scan: "bg-blue-500/15 text-blue-400 font-semibold border border-blue-500/10",
  watcher: "bg-purple-500/15 text-purple-400 font-semibold border border-purple-500/10",
  upgrade: "bg-green-500/15 text-green-400 font-semibold border border-green-500/10",
  skip: "bg-gray-500/15 text-gray-400 font-semibold border border-gray-500/10",
  dryrun: "bg-yellow-500/15 text-yellow-400 font-semibold border border-yellow-500/10",
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function QueuePage() {
  const [watching, setWatching] = React.useState<boolean | null>(null);
  const [processing, setProcessing] = React.useState<string[] | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [rescanning, setRescanning] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const refresh = React.useCallback(() => {
    fetch("/api/system/status").then((r) => r.json()).then((d) => setWatching(d.watching)).catch(() => setWatching(null));
    fetch("/api/system/processing").then((r) => r.json()).then((files: string[]) => setProcessing(Array.isArray(files) ? files : [])).catch(() => setProcessing([]));
    fetch("/api/events?limit=25").then((r) => r.json()).then((data: ActivityEvent[]) => setEvents(Array.isArray(data) ? data : [])).catch(() => setEvents([]));
  }, []);

  React.useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  React.useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(watching ? "/api/system/watch/stop" : "/api/system/watch/start", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg({ ok: false, text: data.error || "Failed to toggle watcher" });
      }
      refresh();
    } catch {
      setMsg({ ok: false, text: "Network error toggling watcher" });
    } finally {
      setBusy(false);
    }
  }

  async function rescan() {
    setRescanning(true);
    try {
      const res = await fetch("/api/system/watch/rescan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) setMsg({ ok: false, text: data.error || "Rescan failed" });
      else setMsg({ ok: true, text: "Watch folder rescanned" });
      refresh();
    } catch {
      setMsg({ ok: false, text: "Network error during rescan" });
    } finally {
      setRescanning(false);
    }
  }

  const grabEvents = React.useMemo(
    () => (events ?? []).filter((e) => ["grab", "download", "import", "upgrade", "error"].includes(e.type)),
    [events],
  );
  const successCount = React.useMemo(
    () => grabEvents.filter((e) => e.type !== "error").length,
    [grabEvents],
  );
  const errorCount = React.useMemo(
    () => grabEvents.filter((e) => e.type === "error").length,
    [grabEvents],
  );

  return (
    <div className="space-y-4">
      {/* Header + watcher control */}
      <GlassPanel className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            <RadioIcon className={cn("size-5 z-10", watching ? "text-signal" : "text-muted-foreground")} />
            {watching && <span className="absolute inset-0 size-5 rounded-full bg-signal/15 animate-ping" />}
          </div>
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Queue</span>
            <h2 className="font-display text-2xl font-bold text-white">
              {watching === null ? "Checking status…" : watching ? "Watching for drops" : "Watcher idle"}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {msg && (
            <span className={cn("text-xs", msg.ok ? "text-emerald-400" : "text-red-400")}>{msg.text}</span>
          )}
          <Button variant="outline" size="sm" onClick={rescan} disabled={rescanning || !watching}>
            {rescanning ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
            Rescan Folder
          </Button>
          <Button variant={watching ? "destructive" : "default"} size="sm" onClick={toggle} disabled={busy || watching === null}>
            {watching ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
            {watching ? "Stop" : "Start"}
          </Button>
        </div>
      </GlassPanel>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Currently Processing" value={processing === null ? "—" : processing.length} accent="signal" />
        <StatTile label="Recent Successes" value={successCount} accent="amber" />
        <StatTile label="Recent Failures" value={errorCount} />
        <StatTile label="Watcher Status" value={watching === null ? "—" : watching ? "Online" : "Offline"} />
      </div>

      {/* Currently processing files */}
      <GlassPanel className="overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/5">
          <h3 className="font-display text-base font-semibold text-white">Processing Now</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Files currently being matched and imported from the watch folder</p>
        </div>
        {processing === null ? (
          <div className="flex items-center justify-center py-10">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : processing.length === 0 ? (
          <p className="text-muted-foreground text-sm px-5 py-8 text-center">Nothing in the queue right now.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {processing.map((path, i) => (
              <div key={`${path}-${i}`} className="flex items-center gap-3 px-5 py-3">
                <FileIcon className="size-4 text-accent-amber shrink-0" />
                <span className="font-mono text-xs text-white/85 truncate" title={path}>{fileName(path)}</span>
                <Loader2Icon className="size-3.5 animate-spin text-muted-foreground ml-auto shrink-0" />
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {/* Recent grab/import activity */}
      <GlassPanel className="overflow-hidden">
        <div className="px-5 py-3.5 border-b border-white/5">
          <h3 className="font-display text-base font-semibold text-white">Recent Activity</h3>
          <p className="text-muted-foreground text-xs mt-0.5">Latest grabs, imports, and upgrades</p>
        </div>
        {events === null ? (
          <div className="flex items-center justify-center py-10">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : grabEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm px-5 py-8 text-center">No grab or import activity yet.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {grabEvents.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-5 py-3">
                <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider shrink-0 mt-0.5", EVENT_BADGES[e.type] ?? "bg-white/5 text-white/60")}>
                  {e.type}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/90 break-words">{e.message}</p>
                  <p className="text-muted-foreground font-mono text-[9px] mt-0.5">
                    {new Date(e.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}

export { QueuePage };
