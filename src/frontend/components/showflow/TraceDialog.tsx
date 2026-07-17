import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@frontend/components/ui/dialog";
import { ScrollArea } from "@frontend/components/ui/scroll-area";
import { cn } from "@frontend/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────

interface TraceEvent {
  id: number;
  stage: string;
  eventType: string;
  reasonCode: string | null;
  reasonCategory: string | null;
  message: string;
  releaseTitle: string | null;
  indexerName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const STAGE_ORDER = ["WANTED", "SEARCHING", "GRABBED", "IMPORTING", "AVAILABLE"] as const;
const FAILED_STAGE = "FAILED";

const REASON_CODE_LABELS: Record<string, string> = {
  NO_INDEXERS_CONFIGURED: "No indexers configured",
  INDEXER_SEARCH_ERROR: "Indexer returned an error",
  INDEXER_UNREACHABLE: "Indexer unreachable or rejected credentials",
  NO_RESULTS_FOUND: "No results found",
  DOWNLOAD_CLIENT_UNREACHABLE: "Download client unreachable or rejected credentials",
  WATCH_FOLDER_UNAVAILABLE: "Watch folder missing or not writable",
  IMPORT_PATH_UNAVAILABLE: "Import path missing or not writable",
  TITLE_OR_SEASON_MISMATCH: "Doesn't match show, season, or episode",
  FORBIDDEN_FORMAT_MATCHED: "Matched a forbidden format",
  MISSING_REQUIRED_FORMAT: "Missing a required format",
  QUALITY_NOT_ALLOWED: "Quality not in profile allow-list",
  QUALITY_UNKNOWN: "Could not identify quality",
  NOT_AN_UPGRADE: "Not an upgrade over existing file",
  GRAB_FAILED_NO_CLIENT: "Grab failed — check download client configuration",
  GRAB_FAILED_INDEXER: "Indexer rejected the grab request",
  GRAB_SUCCEEDED: "Sent to download client",
};

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return formatTime(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + formatTime(iso);
}

function stageColor(stage: string): string {
  if (stage === FAILED_STAGE) return "text-destructive";
  if (stage === "AVAILABLE") return "text-emerald-400";
  if (stage === "GRABBED") return "text-purple-400";
  if (stage === "IMPORTING") return "text-accent-amber";
  if (stage === "SEARCHING") return "text-blue-400";
  if (stage === "WANTED") return "text-muted-foreground";
  return "text-muted-foreground";
}

function stageBg(stage: string): string {
  if (stage === FAILED_STAGE) return "bg-destructive/15 border-destructive/10";
  if (stage === "AVAILABLE") return "bg-emerald-500/10 border-emerald-500/10";
  if (stage === "GRABBED") return "bg-purple-500/10 border-purple-500/10";
  if (stage === "IMPORTING") return "bg-accent-amber/10 border-accent-amber/10";
  if (stage === "SEARCHING") return "bg-blue-500/10 border-blue-500/10";
  return "bg-white/5 border-white/5";
}

function eventIcon(eventType: string) {
  if (eventType.includes("fail") || eventType.includes("error") || eventType.includes("reject") || eventType.includes("skip")) {
    return AlertCircleIcon;
  }
  if (eventType.includes("complete") || eventType.includes("success")) {
    return CheckCircle2Icon;
  }
  return ClockIcon;
}

// ── Sub-components ────────────────────────────────────────────────────────

function StageHeader({ stage }: { stage: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="relative flex items-center justify-center">
        <div className={cn("size-3 rounded-full ring-2 ring-background", stageColor(stage).replace("text-", "bg-"))} />
        <div className={cn("absolute size-3 rounded-full animate-ping opacity-40", stageColor(stage).replace("text-", "bg-"))} />
      </div>
      <span className={cn("font-mono text-xs font-bold uppercase tracking-widest", stageColor(stage))}>
        {stage}
      </span>
      {stage === FAILED_STAGE && (
        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-mono text-destructive border border-destructive/10">
          Blocked
        </span>
      )}
      {stage === "AVAILABLE" && (
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-mono text-emerald-400 border border-emerald-500/10">
          Done
        </span>
      )}
    </div>
  );
}

function EventRow({ event }: { event: TraceEvent }) {
  const Icon = eventIcon(event.eventType);
  const isError = event.reasonCode && event.reasonCode !== "GRAB_SUCCEEDED";
  const reasonLabel = event.reasonCode ? REASON_CODE_LABELS[event.reasonCode] ?? event.reasonCode : null;

  return (
    <div className="relative pl-8 pb-4 last:pb-0">
      {/* Timeline connector */}
      <div className="absolute left-[5px] top-2 bottom-0 w-px bg-white/5 last:hidden" />

      {/* Event dot */}
      <div className="absolute left-0 top-1.5">
        <Icon className={cn("size-3", isError ? "text-destructive" : "text-muted-foreground")} />
      </div>

      {/* Event body */}
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider shrink-0",
                isError
                  ? "bg-destructive/15 text-destructive border border-destructive/10"
                  : "bg-white/5 text-white/60 border border-white/5",
              )}
            >
              {event.eventType}
            </span>
            <span className="text-xs text-white/80 break-words">{event.message}</span>
          </div>
          <span className="text-muted-foreground font-mono text-[9px] shrink-0 whitespace-nowrap">
            {formatDate(event.createdAt)}
          </span>
        </div>

        {/* Reason code label */}
        {reasonLabel && (
          <p className={cn("text-xs", isError ? "text-red-400" : "text-emerald-400")}>
            {reasonLabel}
          </p>
        )}

        {/* Release title + indexer */}
        {event.releaseTitle && (
          <p className="text-muted-foreground text-[10px] font-mono truncate" title={event.releaseTitle}>
            {event.releaseTitle}
          </p>
        )}
        {event.indexerName && (
          <p className="text-muted-foreground text-[10px]">
            via {event.indexerName}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

function TracePanel({
  showId,
  season,
  episode,
}: {
  showId: string;
  season: number;
  episode: number;
}) {
  const [events, setEvents] = React.useState<TraceEvent[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`/api/shows/${showId}/seasons/${season}/episodes/${episode}/trace`)
      .then((r) => r.json())
      .then((data: TraceEvent[]) => setEvents(Array.isArray(data) ? data : []))
      .catch(() => setError("Failed to load trace data"));
  }, [showId, season, episode]);

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  }

  if (events === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <SearchIcon className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No pipeline events recorded for this episode.</p>
        <p className="text-xs text-muted-foreground/60">Events appear once the grabber or import process touches it.</p>
      </div>
    );
  }

  // Group events by stage, preserving chronological order within each stage
  const stages = new Map<string, TraceEvent[]>();
  for (const ev of events) {
    if (!stages.has(ev.stage)) stages.set(ev.stage, []);
    stages.get(ev.stage)!.push(ev);
  }

  // Sort stages: FAILED goes last, otherwise by STAGE_ORDER
  const stageKeys = [...stages.keys()].sort((a, b) => {
    if (a === FAILED_STAGE) return 1;
    if (b === FAILED_STAGE) return -1;
    const ai = STAGE_ORDER.indexOf(a as any);
    const bi = STAGE_ORDER.indexOf(b as any);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <div className="relative pl-2">
      {stageKeys.map((stage) => (
        <div key={stage}>
          <StageHeader stage={stage} />
          <div className={cn("rounded-lg border p-3 mb-4 space-y-1", stageBg(stage))}>
            {stages.get(stage)!.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Dialog wrapper ────────────────────────────────────────────────────────

function TraceDialog({
  open,
  onOpenChange,
  showId,
  showTitle,
  season,
  episode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Pipeline Trace</DialogTitle>
          <DialogDescription>
            {showTitle} &mdash; S{String(season).padStart(2, "0")}E{String(episode).padStart(2, "0")}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1 -mx-6 px-6">
          <TracePanel showId={showId} season={season} episode={episode} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export { TraceDialog, TracePanel };
export type { TraceEvent };
