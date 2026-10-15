import * as React from "react";
import { BellIcon, AlertTriangleIcon, XCircleIcon, InfoIcon, ChevronDownIcon, Loader2Icon, CheckIcon, XIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import { openAppLink } from "@frontend/lib/router";
import { usePolling } from "@frontend/lib/usePolling";

interface Notification {
  id: string;
  type: 'health' | 'pipeline_failure' | 'event' | 'update';
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

type Tab = 'all' | 'alerts' | 'jobs' | 'activity';

// Single combined control for everything time-based: alerts that need
// attention, live background jobs, and the routine activity log. One icon,
// one panel, filterable — instead of separate bell / spinner / feedback
// buttons all competing for the same header space.
// Mount this ONCE (App header) — it polls.
export function NotificationsPopover() {
  const [data, setData] = React.useState<NotificationsResponse | null>(null);
  const [jobs, setJobs] = React.useState<BackgroundJob[]>([]);
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>('all');
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const popoverRef = React.useRef<HTMLDivElement>(null);

  usePolling(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) setData(await res.json());
    } catch {}
  }, 15000);

  usePolling(async () => {
    try {
      const res = await fetch("/api/background-jobs");
      if (res.ok) setJobs(await res.json());
    } catch {}
  }, 3000);

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

  async function dismissAll() {
    if (!data || data.priority.length === 0) return;
    try {
      const res = await fetch("/api/notifications/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: data.priority.map(n => n.id) }),
      });
      if (res.ok) {
        setData(prev => (prev ? { ...prev, priority: [], unreadCount: 0 } : prev));
      }
    } catch {}
  }

  function openLink(link: string) {
    // Server links like "/queue" or "/settings?tab=health" go through the
    // hash router (no reload); anything else is a real navigation.
    setOpen(false);
    openAppLink(link);
  }

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

  const showPriority = hasPriority && (tab === 'all' || tab === 'alerts');
  const showJobs = hasJobs && (tab === 'all' || tab === 'jobs');
  const showRecent = hasRecent && (tab === 'all' || tab === 'activity');
  const nothingToShow = !showPriority && !showJobs && !showRecent;

  return (
    <div ref={popoverRef} className="relative">
      <Button
        size="icon-sm"
        variant="ghost"
        className={cn("relative size-8 rounded-full focus-visible:ring-2 focus-visible:ring-signal/70", unread > 0 && "text-signal")}
        onClick={() => setOpen(!open)}
        title={unread > 0 ? `${unread} notification(s)` : "Notifications & activity"}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications & activity"}
        aria-expanded={open}
      >
        <BellIcon className="size-4" />
        {activeJobs.length > 0 && (
          <span className="absolute -bottom-0.5 -left-0.5 flex size-2.5 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-0.5 text-[11px] leading-none font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-white/10 bg-popover shadow-xl backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3 border-b border-white/5">
            <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Notifications
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {(['all', 'alerts', 'jobs', 'activity'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70",
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
                {tab === 'alerts' ? "No alerts" : tab === 'jobs' ? "No background jobs" : tab === 'activity' ? "No recent activity" : "No notifications"}
              </p>
            )}

            {showPriority && (
              <>
                <div className="px-3 py-1.5 flex items-center justify-between gap-2">
                  <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-red-400">
                    Needs Attention
                  </p>
                  <button
                    onClick={dismissAll}
                    className="rounded-full px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground bg-white/[0.03] hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70"
                    title="Dismiss all current alerts"
                  >
                    Clear
                  </button>
                </div>
                {data!.priority.map(n => (
                  <div key={n.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0">
                    {severityIcon(n.severity)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{n.title}</p>
                      {n.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground mt-1 font-mono">
                        {new Date(n.timestamp).toLocaleString()}
                      </p>
                    </div>
                    {n.link && (
                      <button onClick={() => openLink(n.link!)} className="text-xs text-signal hover:underline shrink-0 mt-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70">View</button>
                    )}
                  </div>
                ))}
              </>
            )}

            {showJobs && (
              <>
                <div className="px-3 py-1.5 border-t border-white/5">
                  <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
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
                      <button onClick={() => openLink(job.link!)} className="text-xs text-signal hover:underline shrink-0 mt-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/70">View</button>
                    )}
                  </div>
                ))}
                {finishedJobs.slice(0, 5).map(job => (
                  <div key={job.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0 opacity-80">
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
                  <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
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
                          "flex items-start gap-3 p-3 opacity-80",
                          isGrouped && "cursor-pointer hover:opacity-100 hover:bg-white/[0.02]",
                        )}
                      >
                        <InfoIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{latest.title}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 font-mono">
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
                            <div key={n.id} className="flex items-start gap-3 pl-10 pr-3 py-1.5">
                              <p className="text-[11px] text-muted-foreground font-mono">
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
