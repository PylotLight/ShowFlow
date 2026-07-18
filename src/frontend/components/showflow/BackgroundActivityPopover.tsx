import * as React from "react";
import { Loader2Icon, XIcon, CheckIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";

interface BackgroundJob {
  id: string;
  type: string;
  label: string;
  status: 'running' | 'done' | 'error';
  progress: { total?: number; completed: number; detail?: string };
  link?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export function BackgroundActivityPopover() {
  const [jobs, setJobs] = React.useState<BackgroundJob[]>([]);
  const [open, setOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/background-jobs");
        if (res.ok) setJobs(await res.json());
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const active = jobs.filter(j => j.status === 'running');
  const finished = jobs.filter(j => j.status !== 'running');

  return (
    <div ref={popoverRef} className="relative">
      <Button
        size="icon-sm"
        variant="ghost"
        className={cn(
          "relative size-8 rounded-full",
          active.length > 0 && "text-signal",
        )}
        onClick={() => setOpen(!open)}
        title={active.length > 0 ? `${active.length} active job(s)` : "Background activity"}
      >
        {active.length > 0 ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <div className="relative">
            <div className="size-2 rounded-full bg-muted-foreground/40" />
            {finished.length > 0 && (
              <span className="absolute -top-1 -right-1 flex size-3 items-center justify-center">
                <span className="size-1.5 rounded-full bg-muted-foreground/60" />
              </span>
            )}
          </div>
        )}
        {active.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-signal text-[9px] font-bold text-white">
            {active.length}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-80 rounded-lg border border-white/10 bg-popover shadow-xl backdrop-blur-xl">
          <div className="p-3 border-b border-white/5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Background Activity
            </p>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {jobs.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground text-center">No recent activity</p>
            )}

            {active.map(job => (
              <div key={job.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0">
                <Loader2Icon className="size-4 mt-0.5 shrink-0 animate-spin text-signal" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{job.label}</p>
                  {job.progress.detail && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{job.progress.detail}</p>
                  )}
                  {job.progress.total != null && job.progress.total > 0 && (
                    <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-signal transition-all duration-500"
                        style={{ width: `${Math.round((job.progress.completed / job.progress.total) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                {job.link && (
                  <a href={job.link} className="text-xs text-signal hover:underline shrink-0 mt-0.5">View</a>
                )}
              </div>
            ))}

            {finished.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-t border-white/5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Recent
                  </p>
                </div>
                {finished.slice(0, 5).map(job => (
                  <div key={job.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0 opacity-60">
                    {job.status === 'done' ? (
                      <CheckIcon className="size-4 mt-0.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XIcon className="size-4 mt-0.5 shrink-0 text-red-400" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{job.label}</p>
                      {job.progress.detail && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{job.progress.detail}</p>
                      )}
                      {job.error && (
                        <p className="text-xs text-red-400 truncate mt-0.5">{job.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
