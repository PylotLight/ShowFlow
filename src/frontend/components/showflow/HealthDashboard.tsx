import {
  ActivityIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loader2Icon,
  NetworkIcon,
  SettingsIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { cn } from "@frontend/lib/utils";

type HealthStatus = "healthy" | "degraded" | "down";

interface HealthRow {
  component_type: string;
  component_id: string;
  component_name: string;
  status: HealthStatus;
  reason_code: string | null;
  reason_category: string | null;
  message: string | null;
  metadata_json: string | null;
  checked_at: string;
}

interface HealthData {
  overallStatus: HealthStatus;
  byType: {
    indexer: HealthRow[];
    download_client: HealthRow[];
    import_path: HealthRow[];
    metadata_provider: HealthRow[];
  };
}

const REASON_CODE_LABELS: Record<string, string> = {
  INDEXER_UNREACHABLE: "Indexer unreachable or rejected credentials",
  DOWNLOAD_CLIENT_UNREACHABLE: "Download client unreachable or rejected credentials",
  WATCH_FOLDER_UNAVAILABLE: "Watch folder missing or not writable",
  IMPORT_PATH_UNAVAILABLE: "Import path missing or not writable",
  NO_INDEXERS_CONFIGURED: "No indexers configured",
  METADATA_PROVIDER_UNREACHABLE: "Metadata provider unreachable (DNS/network block?)",
};

const SECTION_META: Record<string, { label: string; icon: React.ElementType; settingsTab: string }> = {
  indexer: { label: "Indexers", icon: NetworkIcon, settingsTab: "indexers" },
  download_client: { label: "Download Clients", icon: HardDriveIcon, settingsTab: "downloads" },
  import_path: { label: "Import Paths", icon: FolderOpenIcon, settingsTab: "downloads" },
  metadata_provider: { label: "Metadata Services", icon: DatabaseIcon, settingsTab: "providers" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function countBy(rows: HealthRow[], status: HealthStatus) {
  return rows.filter((r) => r.status === status).length;
}

function HealthDashboard({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const [data, setData] = React.useState<HealthData | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(() => {
    fetch("/api/system/health")
      .then((r) => r.json())
      .then((d: HealthData) => setData(d))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const SECTIONS = ["indexer", "download_client", "import_path", "metadata_provider"] as const;

  const totalRows = data
    ? SECTIONS.reduce((sum, t) => sum + data.byType[t].length, 0)
    : 0;

  return (
    <div className="space-y-4">
      {/* Overall status banner */}
      <GlassPanel className="flex items-center justify-between p-5">
        <div className="flex items-center gap-3">
          <ActivityIcon
            className={cn(
              "size-5",
              data?.overallStatus === "healthy" && "text-emerald-400",
              data?.overallStatus === "degraded" && "text-accent-amber",
              data?.overallStatus === "down" && "text-destructive",
            )}
          />
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Health</span>
            <h2 className="font-display text-2xl font-bold text-white mt-0.5">
              {data === null
                ? "Checking system health\u2026"
                : data.overallStatus === "healthy"
                  ? "All systems operational"
                  : data.overallStatus === "degraded"
                    ? "System degraded"
                    : "System unavailable"}
            </h2>
            <p className="text-muted-foreground text-xs mt-1">
              {data === null
                ? ""
                : data.overallStatus === "healthy"
                  ? `${totalRows} component${totalRows !== 1 ? "s" : ""} checked, all healthy`
                  : `${SECTIONS.reduce((s, t) => s + countBy(data.byType[t], "down"), 0)} down, ${SECTIONS.reduce((s, t) => s + countBy(data.byType[t], "degraded"), 0)} degraded — resolve issues below`}
            </p>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold font-mono uppercase tracking-wider",
            data?.overallStatus === "healthy" && "bg-emerald-500/15 text-emerald-400 border border-emerald-500/10",
            data?.overallStatus === "degraded" && "bg-accent-amber/15 text-accent-amber border border-accent-amber/10",
            data?.overallStatus === "down" && "bg-destructive/15 text-destructive border border-destructive/10",
          )}
        >
          {data?.overallStatus ?? "\u00a0"}
        </span>
      </GlassPanel>

      {/* Per-type sections */}
      {data === null ? (
        <div className="flex items-center justify-center py-24">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : totalRows === 0 ? (
        <GlassPanel className="p-10 text-center">
          <ActivityIcon className="size-8 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-display text-lg font-bold text-white mb-1">No components checked yet</h3>
          <p className="text-muted-foreground text-sm">
            The health poller runs every 5 minutes. Check back soon or configure indexers, download clients, and import paths.
          </p>
        </GlassPanel>
      ) : (
        SECTIONS.map((type) => {
          const rows = data.byType[type];
          const meta = SECTION_META[type]!;
          const downCount = countBy(rows, "down");
          const degradedCount = countBy(rows, "degraded");
          const healthyCount = countBy(rows, "healthy");
          if (rows.length === 0) return null;

          return (
            <GlassPanel key={type} className="overflow-hidden">
              {/* Section header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5">
                <div className="flex items-center gap-2.5">
                  <meta.icon className="size-4 text-signal" />
                  <h3 className="font-display text-base font-semibold text-white">{meta.label}</h3>
                </div>
                <div className="flex items-center gap-2.5 font-mono text-caption">
                  {downCount > 0 && <span className="text-destructive">{downCount} down</span>}
                  {degradedCount > 0 && <span className="text-accent-amber">{degradedCount} degraded</span>}
                  <span className="text-emerald-400">{healthyCount} healthy</span>
                </div>
              </div>

              {/* Rows */}
              <div className="divide-y divide-white/5">
                {rows.map((row) => {
                  const key = `${row.component_type}:${row.component_id}`;
                  const isOpen = expanded.has(key);
                  const isDown = row.status === "down";
                  const isDegraded = row.status === "degraded";
                  const hasIssue = isDown || isDegraded;
                  const reasonDef = row.reason_code ? REASON_CODE_LABELS[row.reason_code] : null;

                  return (
                    <div key={key}>
                      {/* Row header - clickable to expand */}
                      <button
                        type="button"
                        onClick={() => toggleExpanded(key)}
                        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-white/[0.02] transition-colors"
                      >
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            row.status === "healthy" && "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]",
                            row.status === "degraded" && "bg-accent-amber shadow-[0_0_6px_theme(colors.accent.amber)]",
                            row.status === "down" && "bg-destructive shadow-[0_0_6px_theme(colors.destructive)]",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="font-mono text-sm font-medium text-white/90">{row.component_name}</span>
                          {row.message && (
                            <p className="text-muted-foreground text-xs mt-0.5 truncate">{row.message}</p>
                          )}
                        </div>
                        {isOpen ? (
                          <ChevronDownIcon className="size-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />
                        )}
                      </button>

                      {/* Expanded diagnosis panel */}
                      {isOpen && (
                        <div className="px-5 py-3.5 bg-white/[0.02] border-t border-white/5 space-y-2.5">
                          {hasIssue && reasonDef && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs text-muted-foreground font-semibold w-20 shrink-0">Diagnosis:</span>
                              <span className="text-xs text-white/90">{reasonDef}</span>
                            </div>
                          )}
                          {row.reason_code && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs text-muted-foreground font-semibold w-20 shrink-0">Reason:</span>
                              <span className="text-xs font-mono text-muted-foreground">{row.reason_code}</span>
                            </div>
                          )}
                          {row.message && (
                            <div className="flex items-start gap-2">
                              <span className="text-xs text-muted-foreground font-semibold w-20 shrink-0">Message:</span>
                              <span className={cn("text-xs", hasIssue ? "text-red-400" : "text-white/70")}>{row.message}</span>
                            </div>
                          )}
                          <div className="flex items-start gap-2">
                            <span className="text-xs text-muted-foreground font-semibold w-20 shrink-0">Checked:</span>
                            <span className="text-xs text-muted-foreground">{timeAgo(row.checked_at)}</span>
                          </div>
                          {hasIssue && (
                            <div className="pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onOpenSettings(meta.settingsTab)}
                                className="h-7 text-xs gap-1.5"
                              >
                                <SettingsIcon className="size-3" />
                                Configure {meta.label}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </GlassPanel>
          );
        })
      )}
    </div>
  );
}

export { HealthDashboard };
