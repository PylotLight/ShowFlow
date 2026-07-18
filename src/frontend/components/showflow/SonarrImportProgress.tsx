import * as React from "react";
import { Loader2Icon, CheckIcon, XIcon, MinusIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";

interface BackgroundJob {
  id: string;
  type: string;
  label: string;
  status: 'running' | 'done' | 'error';
  progress: { total?: number; completed: number; detail?: string };
}

interface ImportResult {
  seriesId: string;
  sonarrSeriesId: number;
  title: string;
  status: 'imported' | 'skipped' | 'existing' | 'error';
  message?: string;
}

interface SonarrImportProgressProps {
  jobId: string;
  onDone?: () => void;
  compact?: boolean;
  /** If true, auto-poll silently and call onDone once import finishes (no interactive UI) */
  silent?: boolean;
  /** When compact + silent, rendered content for the outer component to use */
  children?: (state: { job: BackgroundJob | null; done: boolean; running: boolean }) => React.ReactNode;
}

export function SonarrImportProgress({ jobId, onDone, compact, silent, children }: SonarrImportProgressProps) {
  const [job, setJob] = React.useState<BackgroundJob | null>(null);
  const [results, setResults] = React.useState<ImportResult[] | null>(null);
  const [fetchingResults, setFetchingResults] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/background-jobs/${jobId}`);
        if (res.ok) {
          const j: BackgroundJob = await res.json();
          if (!cancelled) setJob(j);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [jobId]);

  React.useEffect(() => {
    if (!job || job.status === 'running' || results) return;
    if (fetchingResults) return;
    setFetchingResults(true);
    fetch(`/api/sonarr/import/${jobId}/results`).then(r => r.json()).then(data => {
      setResults(data);
    }).catch(() => {}).finally(() => setFetchingResults(false));
  }, [job, jobId, results, fetchingResults]);

  const done = job?.status === 'done' || job?.status === 'error';
  const running = job?.status === 'running';
  const pct = job?.progress.total && job.progress.total > 0
    ? Math.round((job.progress.completed / job.progress.total) * 100)
    : 0;

  if (silent && children) {
    return <>{children({ job, done, running })}</>;
  }

  if (compact && job) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/5">
        {running ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-signal" />
        ) : job.status === 'done' ? (
          <CheckIcon className="size-4 shrink-0 text-emerald-500" />
        ) : (
          <XIcon className="size-4 shrink-0 text-red-400" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">
            {running ? "Importing series..." : job.status === 'done' ? "Import complete" : "Import failed"}
          </p>
          {job.progress.detail && (
            <p className="text-[11px] text-muted-foreground truncate">{job.progress.detail}</p>
          )}
        </div>
        {running && job.progress.total && job.progress.total > 0 && (
          <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-signal transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {running ? (
          <Loader2Icon className="size-5 shrink-0 animate-spin text-signal" />
        ) : job?.status === 'done' ? (
          <div className="size-5 shrink-0 rounded-full bg-emerald-500/20 flex items-center justify-center">
            <CheckIcon className="size-3 text-emerald-500" />
          </div>
        ) : done ? (
          <div className="size-5 shrink-0 rounded-full bg-red-500/20 flex items-center justify-center">
            <XIcon className="size-3 text-red-400" />
          </div>
        ) : (
          <div className="size-5 shrink-0 rounded-full bg-white/10" />
        )}
        <div className="flex-1 min-w-0">
          <p className={cn(
            "text-sm font-medium",
            running && "text-signal",
            job?.status === 'done' && "text-emerald-400",
            job?.status === 'error' && "text-red-400",
          )}>
            {running
              ? `Importing series...`
              : job?.status === 'done'
                ? `Import complete`
                : job?.status === 'error'
                  ? `Import failed`
                  : `Starting import...`
            }
          </p>
          {job?.progress.detail && (
            <p className="text-xs text-muted-foreground mt-0.5">{job.progress.detail}</p>
          )}
        </div>
      </div>

      {running && job?.progress.total && job.progress.total > 0 && (
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
            <span>{job.progress.completed} / {job.progress.total} series</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-signal transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1 rounded-xl border border-white/10 p-2">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm">
              {r.status === 'imported' && (
                <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
              )}
              {r.status === 'existing' && (
                <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {r.status === 'error' && (
                <XIcon className="size-3.5 shrink-0 text-red-400" />
              )}
              {r.status === 'skipped' && (
                <MinusIcon className="size-3.5 shrink-0 text-yellow-500" />
              )}
              <span className="flex-1 truncate">{r.title}</span>
              <span className={cn(
                "text-xs shrink-0",
                r.status === 'imported' && "text-emerald-500",
                r.status === 'existing' && "text-muted-foreground",
                r.status === 'error' && "text-red-400",
              )}>
                {r.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {done && onDone && (
        <Button onClick={onDone} className="w-full h-10 rounded-xl gap-2 mt-2">
          <CheckIcon className="size-4" />
          Continue
        </Button>
      )}
    </div>
  );
}
