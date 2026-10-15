import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@frontend/components/ui/tabs";
import { HealthDashboard } from "@frontend/components/showflow/HealthDashboard";
import { HistoryPage } from "@frontend/components/showflow/HistoryPage";
import { ManualImport } from "@frontend/components/showflow/ManualImport";
import { QueuePage } from "@frontend/components/showflow/QueuePage";
import { ACTIVITY_TABS, activityHash, navigate, type ActivityTab } from "@frontend/lib/router";
import { usePolling } from "@frontend/lib/usePolling";
import { cn } from "@frontend/lib/utils";

/**
 * One home for "what is ShowFlow doing": live queue (Now), History, Manual
 * Import and Health, as tabs. Each tab is the existing page component,
 * wrapped as-is; only the active tab is mounted, so their own polling and
 * <HeaderActions> only run while visible. Tab lives in the URL
 * (#/activity/:tab).
 */
export function ActivityPage({ tab, onOpenSettings }: {
  tab: ActivityTab;
  onOpenSettings: (tab: string) => void;
}) {
  const [nowCount, setNowCount] = React.useState(0);
  const [manualCount, setManualCount] = React.useState(0);

  // Tiny counts for the tab badges (same endpoints the sidebar uses).
  usePolling(() => {
    fetch("/api/system/processing")
      .then((r) => r.json())
      .then((files: unknown) => setNowCount(Array.isArray(files) ? files.length : 0))
      .catch(() => {});
    fetch("/api/manual-import/count")
      .then((r) => r.json())
      .then((d: { count?: number }) => setManualCount(d.count ?? 0))
      .catch(() => {});
  }, 15_000);

  const badges: Partial<Record<ActivityTab, { n: number; hint: string }>> = {
    now: { n: nowCount, hint: "active downloads" },
    "manual-import": { n: manualCount, hint: "files awaiting import" },
  };

  return (
    <Tabs value={tab} onValueChange={(t) => navigate(activityHash(t as ActivityTab))} className="gap-4">
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <TabsList aria-label="Activity sections" className="min-w-max">
          {ACTIVITY_TABS.map((t) => {
            const b = badges[t.id];
            return (
              <TabsTrigger key={t.id} value={t.id} className="px-3 text-xs sm:px-4 sm:text-sm">
                {t.label}
                {b && b.n > 0 && (
                  <span
                    title={`${b.n} ${b.hint}`}
                    aria-label={`${b.n} ${b.hint}`}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[11px] font-bold leading-none",
                      tab === t.id ? "bg-signal-foreground/20" : "bg-white/10 text-white/80",
                    )}
                  >
                    {b.n}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>

      <TabsContent value="now"><QueuePage /></TabsContent>
      <TabsContent value="history"><HistoryPage /></TabsContent>
      <TabsContent value="manual-import"><ManualImport /></TabsContent>
      <TabsContent value="health"><HealthDashboard onOpenSettings={onOpenSettings} /></TabsContent>
    </Tabs>
  );
}
