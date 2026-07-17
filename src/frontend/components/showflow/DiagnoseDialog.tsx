import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LightbulbIcon,
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
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────

interface DiagnosisEvent {
  id: number;
  stage: string;
  eventType: string;
  message: string;
  reasonCode: string | null;
  createdAt: string;
}

interface DiagnosisDef {
  label: string;
  category: string;
  confidence: string;
  suggestedAction: string;
}

interface DiagnoseResponse {
  hasIssue: boolean;
  event: DiagnosisEvent | null;
  diagnosis: DiagnosisDef | null;
  suggestedAction: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  indexer: "Indexer Issue",
  download_client: "Download Client Issue",
  disk_permissions: "Disk / Permissions Issue",
  release_quality: "Quality Profile Issue",
  naming_mismatch: "Naming Mismatch",
  network: "Network Issue",
  config: "Configuration Issue",
  success: "Success",
};

// ── Component ─────────────────────────────────────────────────────────────

function DiagnosePanel({
  showId,
  season,
  episode,
}: {
  showId: string;
  season: number;
  episode: number;
}) {
  const [result, setResult] = React.useState<DiagnoseResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch(`/api/shows/${showId}/seasons/${season}/episodes/${episode}/diagnose`)
      .then((r) => r.json())
      .then((data: DiagnoseResponse) => setResult(data))
      .catch(() => setError("Failed to run diagnosis"));
  }, [showId, season, episode]);

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!result.hasIssue) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2">
        <CheckCircle2Icon className="size-6 text-emerald-400" />
        <p className="text-sm text-emerald-400 font-semibold">No issues detected</p>
        <p className="text-xs text-muted-foreground/60">
          The latest pipeline event indicates no failure.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Issue summary */}
      <div className="rounded-lg border border-destructive/10 bg-destructive/5 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <AlertCircleIcon className="size-4 text-destructive shrink-0" />
          <span className="text-sm font-semibold text-destructive">Issue detected</span>
        </div>
        {result.diagnosis && (
          <p className="text-sm text-white/90">{result.diagnosis.label}</p>
        )}
        {result.diagnosis?.category && (
          <p className="text-xs text-muted-foreground">
            Category: {CATEGORY_LABELS[result.diagnosis.category] ?? result.diagnosis.category}
            <span className="ml-2 opacity-60">
              (confidence: {result.diagnosis.confidence})
            </span>
          </p>
        )}
      </div>

      {/* Event detail */}
      {result.event && (
        <div className="space-y-1.5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Latest event</span>
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-white/60 border border-white/5">
                {result.event.eventType}
              </span>
              <span className="text-xs text-white/80">{result.event.message}</span>
            </div>
            {result.event.reasonCode && (
              <p className="text-xs font-mono text-muted-foreground">{result.event.reasonCode}</p>
            )}
          </div>
        </div>
      )}

      {/* Suggested action */}
      {result.suggestedAction && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <LightbulbIcon className="size-3.5 text-accent-amber" />
            <span className="text-xs font-semibold text-accent-amber uppercase tracking-wider">Suggested action</span>
          </div>
          <div className="rounded-lg border border-accent-amber/10 bg-accent-amber/5 p-3">
            <p className="text-sm text-white/90">{result.suggestedAction}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dialog wrapper ────────────────────────────────────────────────────────

function DiagnoseDialog({
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Failure Diagnosis</DialogTitle>
          <DialogDescription>
            {showTitle} &mdash; S{String(season).padStart(2, "0")}E{String(episode).padStart(2, "0")}
          </DialogDescription>
        </DialogHeader>
        <DiagnosePanel showId={showId} season={season} episode={episode} />
      </DialogContent>
    </Dialog>
  );
}

export { DiagnoseDialog, DiagnosePanel };
export type { DiagnoseResponse, DiagnosisDef };
