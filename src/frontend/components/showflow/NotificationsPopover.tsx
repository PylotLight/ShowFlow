import * as React from "react";
import { BellIcon, AlertTriangleIcon, XCircleIcon, InfoIcon, CheckIcon, XIcon, Loader2Icon } from "lucide-react";
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

export function NotificationsPopover() {
  const [data, setData] = React.useState<NotificationsResponse | null>(null);
  const [open, setOpen] = React.useState(false);
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

  function severityIcon(sev: string) {
    switch (sev) {
      case 'error': return <XCircleIcon className="size-4 shrink-0 text-red-400" />;
      case 'warning': return <AlertTriangleIcon className="size-4 shrink-0 text-amber-400" />;
      default: return <InfoIcon className="size-4 shrink-0 text-muted-foreground" />;
    }
  }

  return (
    <div ref={popoverRef} className="relative">
      <Button
        size="icon-sm"
        variant="ghost"
        className={cn("relative size-8 rounded-full", unread > 0 && "text-signal")}
        onClick={() => setOpen(!open)}
        title={unread > 0 ? `${unread} notification(s)` : "Notifications"}
      >
        <BellIcon className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-signal text-[9px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-80 rounded-lg border border-white/10 bg-popover shadow-xl backdrop-blur-xl">
          <div className="p-3 border-b border-white/5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Notifications
            </p>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {(!data || (data.priority.length === 0 && data.recent.length === 0)) && (
              <p className="p-4 text-sm text-muted-foreground text-center">No notifications</p>
            )}

            {data && data.priority.length > 0 && (
              <>
                <div className="px-3 py-1.5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-400/80">
                    Needs Attention
                  </p>
                </div>
                {data.priority.map(n => (
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

            {data && data.recent.length > 0 && (
              <>
                <div className="px-3 py-1.5 border-t border-white/5">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Recent Activity
                  </p>
                </div>
                {data.recent.map(n => (
                  <div key={n.id} className="flex items-start gap-3 p-3 border-b border-white/5 last:border-0 opacity-70">
                    <InfoIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{n.title}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
                        {new Date(n.timestamp).toLocaleString()}
                      </p>
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
