import * as React from "react";
import { BellIcon, AlertTriangleIcon, XCircleIcon, InfoIcon, ChevronDownIcon, Loader2Icon, CheckIcon, XIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";

interface Notification {
  id: string;
  type: 'health' | 'pipeline_failure' | 'event';
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string | null;
  reasonCode: string | null;
  timestamp: string;
  link?: string | null;
}

interface NotificationsResponse {
  priority: Notification[];
  recent: Notification[];
  unreadCount: number;
}

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

interface RecentGroup {
  key: string;
  title: string;
  items: Notification[];
}

// Collapse consecutive entries that share a title (e.g. a burst of identical
// "Task health-check completed successfully" rows from a bulk action) into a
// single row with a count, so one unusual event isn't buried under a hundred
// routine ones.
function groupConsecutive(items: Notification[]): RecentGroup[] {
  const groups: RecentGroup[] = [];
  for (const n of items) {
    const last = groups[groups.length - 1];
    if (last && last.title === n.title) {
      last.items.push(n);
    } else {
      groups.push({ key: n.id, title: n.title, items: [n] });
    }
  }
  return groups;
}

type Tab = 'all' | 'alerts' | 'activity';

// Single combined control for everything time-based: alerts that need
// attention, live background jobs, and the routine activity log. One icon,
// one panel, filterable — instead of separate bell / spinner / feedback
// buttons all competing for the same header space.
export function NotificationsPopover() {
  const [data, setData] = React.useState<NotificationsResponse | null>(null);
  const [jobs, setJobs] = React.useState<BackgroundJob[]>([]);
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>('all');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const popoverRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const fetchNotifs = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (res.ok) setData(await res.json());
      } catch {}
    };
    fetchNotifs();
    const interval = setInterval(fetchNotifs, 15000);
    return () => clearInterval(interval);
  }, []);

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

  const unread = data?.unreadCount ?? 0;
  const activeJobs = jobs.filter(j => j.status === 'running');
  const finishedJobs = jobs.filter(j => j.status !== 'running');

  function severityIcon(sev: string) {
    switch (sev) {
      case 'error': return <XCircleIcon className="size-4 shrink-0 text-red-400" />;
      case 'warning': return <AlertTriangleIcon className="size-4 shrink-0 text-amber-400" />;
      default: return <InfoIcon className="size-4 shrink-0 text-muted-foreground" />;
    }
  }

  function toggleExpanded(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const recentGroups = React.useMemo(
    () => (data ? groupConsecutive(data.recent) : []),
    [data],
  );

  const hasPriority = !!data && data.priority.length > 0;
  const hasJobs = activeJobs.length > 0 || finishedJobs.length > 0;
  const hasRecent = recentGroups.length > 0;

  const showPriority = hasPriority && tab !== 'activity';
  const showJobs = hasJobs && tab !== 'alerts';
  const showRecent = hasRecent && tab !== 'alerts';
  const nothingToShow = !showPriority && !showJobs && !showRecent;

  return (
    <div ref={popoverRef} className="relative">
      <Button
        size="icon-sm"
        variant="ghost"
        className={cn("relative size-8 rounded-full", unread > 0 && "text-signal")}
        onClick={() => setOpen(!open)}
        title={unread > 0 ? `${unread} notification(s)` : "Notifications & activity"}
      >
        <BellIcon className="size-4" />
        {activeJobs.length > 0 && (
          <span className="absolute -bottom-0.5 -left-0.5 flex size-2.5 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-signal text-[9px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-popover shadow-xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3 p-3 border-b border-white/5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Notifications
            </p>
            <div className="flex items-center gap-1">
              {(['all', 'alerts', 'activity'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-all",
                    tab === t
                      ? "bg-signal/15 text-signal font-semibold"
                      : "text-muted-foreground hover:text-foreground bg-white/[0.03] hover:bg-white/[0.06]",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[28rem] overflow-y-auto">
            {nothingToShow && (
              <p className="p-4 text-sm text-muted-foreground text-center">
                {tab === 'alerts' ? "No alerts" : tab === 'activity' ? "No recent activity" : "No notifications"}
              </p>
            )}

            {showPriority && (
              <>
                <div className="px-3 py-1.5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-400/80">
                    Needs Attention
                  </p>
                </div>
                {data!.priority.map(n => (
                  <div key={n.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0">
                    {severityIcon(n.severity)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{n.title}</p>
                      {n.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">
                        {new Date(n.timestamp).toLocaleString()}
                      </p>
                    </div>
                    {n.link && (
                      <a href={n.link} className="text-xs text-signal hover:underline shrink-0 mt-0.5">View</a>
                    )}
                  </div>
                ))}
              </>
            )}

            {showJobs && (
              <>
                <div className="px-3 py-1.5 border-t border-white/5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Background Jobs
                  </p>
                </div>
                {activeJobs.map(job => (
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
                {finishedJobs.slice(0, 5).map(job => (
                  <div key={job.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0 opacity-60">
                    {job.status === 'done' ? (
                      <CheckIcon className="size-4 mt-0.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XIcon className="size-4 mt-0.5 shrink-0 text-red-400" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{job.label}</p>
                      {job.error && (
                        <p className="text-xs text-red-400 truncate mt-0.5">{job.error}</p>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}

            {showRecent && (
              <>
                <div className="px-3 py-1.5 border-t border-white/5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Recent Activity
                  </p>
                </div>
                {recentGroups.map(group => {
                  const latest = group.items[0]!;
                  const isExpanded = expanded.has(group.key);
                  const isGrouped = group.items.length > 1;
                  return (
                    <div key={group.key} className="border-b border-white/5 last:border-0">
                      <div
                        onClick={() => isGrouped && toggleExpanded(group.key)}
                        className={cn(
                          "flex items-start gap-3 p-3 opacity-70",
                          isGrouped && "cursor-pointer hover:opacity-100 hover:bg-white/[0.02]",
                        )}
                      >
                        <InfoIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{latest.title}</p>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
                            {new Date(latest.timestamp).toLocaleString()}
                            {isGrouped && ` · ${group.items.length}×`}
                          </p>
                        </div>
                        {isGrouped && (
                          <ChevronDownIcon className={cn(
                            "size-3.5 mt-0.5 shrink-0 text-muted-foreground transition-transform",
                            isExpanded && "rotate-180",
                          )} />
                        )}
                      </div>
                      {isGrouped && isExpanded && (
                        <div className="pb-1">
                          {group.items.slice(1).map(n => (
                            <div key={n.id} className="flex items-start gap-3 pl-10 pr-3 py-1.5 opacity-50">
                              <p className="text-[10px] text-muted-foreground/60 font-mono">
                                {new Date(n.timestamp).toLocaleString()}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
