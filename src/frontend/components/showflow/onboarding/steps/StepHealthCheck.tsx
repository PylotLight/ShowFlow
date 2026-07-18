import * as React from "react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  XCircleIcon,
  Loader2Icon,
  RefreshCwIcon,
  ActivityIcon,
} from "lucide-react";
import type { StepProps } from "../types";

interface HealthItem {
  componentType: string;
  componentId: string;
  componentName: string;
  status: 'healthy' | 'degraded' | 'down';
  reasonCode: string | null;
  message: string | null;
}

export function StepHealthCheck({ onNext }: StepProps) {
  const [items, setItems] = React.useState<HealthItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchHealth = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system/health");
      if (res.ok) setItems(await res.json());
      else setError("Could not load health data");
    } catch { setError("Failed to fetch health"); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { fetchHealth(); }, [fetchHealth]);

  const overall = !loading && !error
    ? items.some(i => i.status === 'down') ? 'down'
      : items.some(i => i.status === 'degraded') ? 'degraded'
      : 'healthy'
    : null;

  const overallConfig = {
    healthy: { label: 'All systems healthy', icon: CheckCircleIcon, color: 'text-green-400', bg: 'bg-green-500/[0.04] border-green-500/20' },
    degraded: { label: 'Some systems need attention', icon: AlertTriangleIcon, color: 'text-amber-400', bg: 'bg-amber-500/[0.04] border-amber-500/20' },
    down: { label: 'Some systems are unavailable', icon: XCircleIcon, color: 'text-red-400', bg: 'bg-red-500/[0.04] border-red-500/20' },
  };

  return (
    <div className="py-4">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight mb-2">Health Check</h2>
        <p className="text-muted-foreground">
          Verify everything is working before finishing setup. Don't worry — you
          can always come back to Settings later.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Checking system health...
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/[0.04] text-sm text-red-400">
          {error}
          <Button variant="ghost" size="sm" onClick={fetchHealth} className="ml-2 gap-1">
            <RefreshCwIcon className="size-3.5" /> Retry
          </Button>
        </div>
      )}

      {!loading && !error && overall && (
        <>
          <div className={cn(
            "p-5 rounded-2xl border flex items-center gap-4 mb-4",
            overallConfig[overall].bg
          )}>
            {React.createElement(overallConfig[overall].icon, { className: cn("size-8", overallConfig[overall].color) })}
            <div>
              <p className={cn("text-base font-semibold", overallConfig[overall].color)}>
                {overallConfig[overall].label}
              </p>
              <p className="text-xs text-muted-foreground">{items.length} component(s) checked</p>
            </div>
          </div>

          <div className="space-y-1.5">
            {items.map(item => (
              <div
                key={`${item.componentType}:${item.componentId}`}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl border text-sm transition-all",
                  item.status === 'healthy' && "border-green-500/20 bg-white/[0.02]",
                  item.status === 'degraded' && "border-amber-500/20 bg-amber-500/[0.03]",
                  item.status === 'down' && "border-red-500/20 bg-red-500/[0.03]",
                )}
              >
                {item.status === 'healthy' && <CheckCircleIcon className="size-4 shrink-0 text-green-400" />}
                {item.status === 'degraded' && <AlertTriangleIcon className="size-4 shrink-0 text-amber-400" />}
                {item.status === 'down' && <XCircleIcon className="size-4 shrink-0 text-red-400" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.componentName}</p>
                  {item.message && (
                    <p className="text-xs text-muted-foreground mt-0.5">{item.message}</p>
                  )}
                </div>
                <span className={cn(
                  "text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded-full shrink-0",
                  item.status === 'healthy' && "text-green-400 bg-green-500/10",
                  item.status === 'degraded' && "text-amber-400 bg-amber-500/10",
                  item.status === 'down' && "text-red-400 bg-red-500/10",
                )}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-8 flex items-center justify-between">
        <div />
        <Button variant="glass" onClick={onNext} className="gap-2 h-11 px-6 rounded-xl">
          Finish setup
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
