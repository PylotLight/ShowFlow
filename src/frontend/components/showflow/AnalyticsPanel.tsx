import * as React from "react";
import { DatabaseIcon, Loader2Icon, RefreshCwIcon, ActivityIcon, FlameIcon, ArchiveIcon, Trash2Icon } from "lucide-react";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { StatTile } from "@frontend/components/showflow/StatTile";
import { Button } from "@frontend/components/ui/button";
import { formatBytes } from "./SettingsShared";

interface TableStat {
  name: string;
  rowCount: number;
}

interface PipelineEventStats {
  total: number;
  last24h: number;
  last7d: number;
  byStage: { stage: string; count: number }[];
  byCategory: { category: string; count: number }[];
  byEventType: { eventType: string; count: number }[];
  oldestEventAt: string | null;
}

interface HourlyBucket {
  hour: string;
  count: number;
}

interface NoisyShow {
  showId: string;
  showTitle: string;
  count: number;
}

interface AnalyticsData {
  dbSizeBytes: number;
  tables: TableStat[];
  pipelineEvents: PipelineEventStats;
  hourlyActivity: HourlyBucket[];
  noisiestShows: NoisyShow[];
  cache: { total: number; expired: number };
}

const STAGE_COLORS: Record<string, string> = {
  WANTED: "text-muted-foreground",
  SEARCHING: "text-signal",
  GRABBED: "text-accent-amber",
  IMPORTING: "text-accent-amber",
  AVAILABLE: "text-emerald-400",
  FAILED: "text-red-400",
};

const CATEGORY_LABELS: Record<string, string> = {
  none: "Progress (no issue)",
  indexer: "Indexer",
  download_client: "Download client",
  disk_permissions: "Disk & permissions",
  release_quality: "Release quality",
  naming_mismatch: "Naming mismatch",
  network: "Network",
  config: "Config",
  success: "Success",
};

function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "< 1 day";
  return `${days} day${days === 1 ? "" : "s"}`;
}

function formatRelative(iso: string | null | undefined, suffix: string): string {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMins < 1) return `Just now`;
  if (diffMins < 60) return `${diffMins}m ${suffix}`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ${suffix}`;
  return `${Math.floor(diffMins / 1440)}d ${suffix}`;
}

function BreakdownList({ items, total }: { items: { label: string; count: number; className?: string }[]; total: number }) {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  return (
    <div className="space-y-2">
      {sorted.map(item => (
        <div key={item.label} className="flex items-center gap-3">
          <span className={`w-40 shrink-0 truncate font-mono text-xs ${item.className ?? "text-foreground/80"}`}>{item.label}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
            <div
              className="h-full rounded-full bg-signal/60"
              style={{ width: total > 0 ? `${Math.max((item.count / total) * 100, 2)}%` : "0%" }}
            />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">{item.count}</span>
        </div>
      ))}
    </div>
  );
}

function Sparkline({ buckets }: { buckets: HourlyBucket[] }) {
  // Fill in the full 24h window even for hours with zero events, so gaps
  // read as "nothing happened" rather than looking like missing data.
  const now = new Date();
  const byHour = new Map(buckets.map(b => [b.hour, b.count]));
  const hours: { key: string; label: string; count: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 13) + ":00";
    hours.push({ key, label: `${d.getHours()}:00`, count: byHour.get(key) ?? 0 });
  }
  const max = Math.max(...hours.map(h => h.count), 1);

  return (
    <div className="flex h-16 items-end gap-1">
      {hours.map(h => (
        <div key={h.key} className="group relative flex-1">
          <div
            className="w-full rounded-sm bg-signal/50 transition-colors group-hover:bg-signal"
            style={{ height: `${Math.max((h.count / max) * 100, h.count > 0 ? 4 : 1)}%` }}
          />
          <div className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 font-mono text-[10px] text-white group-hover:block">
            {h.label} · {h.count}
          </div>
        </div>
      ))}
    </div>
  );
}

type CleanupAction = "prune-episode-files" | "purge-scan-logs" | "vacuum";

const KEEP_DAY_OPTIONS = [1, 2, 7, 14, 30];

/**
 * Manual database sweeps (issues-tracking #29). Each action runs as a
 * background job because big-table purges and VACUUM take minutes — the
 * button returns immediately with a jobId and this polls the job until it
 * settles, then refreshes the page stats.
 */
function DatabaseCleanup({ sweepTask, onDone }: { sweepTask: any; onDone: () => void }) {
  const [keepDays, setKeepDays] = React.useState(7);
  const [busyAction, setBusyAction] = React.useState<CleanupAction | null>(null);
  const [jobDetail, setJobDetail] = React.useState<string | null>(null);
  const [jobError, setJobError] = React.useState<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function pollJob(jobId: string, action: CleanupAction) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const job = await fetch(`/api/background-jobs/${jobId}`).then(r => r.json()).catch(() => null);
      if (!job) return;
      if (job.status === "running") {
        setJobDetail(job.progress?.detail ?? "Working…");
        return;
      }
      if (pollRef.current) clearInterval(pollRef.current);
      setBusyAction(null);
      if (job.status === "done") {
        setJobDetail(job.progress?.detail ?? "Done.");
        setJobError(null);
      } else {
        setJobError(job.error ?? "Cleanup failed.");
      }
      onDone();
    }, 2000);
  }

  async function start(action: CleanupAction) {
    if (action === "vacuum" && !confirm(
      "Vacuum rewrites the whole database file to reclaim space. It locks the database for a few minutes — the UI will show 502s until it finishes, then recover on its own. Continue?"
    )) return;
    setBusyAction(action);
    setJobDetail("Starting…");
    setJobError(null);
    const res = await fetch("/api/system/db-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, keepDays }),
    }).then(r => r.json()).catch(() => null);
    if (!res?.jobId) {
      setBusyAction(null);
      setJobError("Couldn't start cleanup.");
      return;
    }
    pollJob(res.jobId, action);
  }

  const busy = busyAction !== null;

  return (
    <GlassPanel className="overflow-hidden">
      <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2">
        <Trash2Icon className="size-4 text-signal" />
        <h4 className="font-display text-sm font-semibold text-white/90">Database Cleanup</h4>
      </div>
      <div className="px-6 py-4 space-y-4">
        <p className="text-muted-foreground text-xs">
          Manual sweeps — the automatic daily sweep ({sweepTask ? (sweepTask.enabled ? "enabled" : "disabled in Tasks") : "pipeline-cleanup"}
          {sweepTask?.lastExecution ? `, last ran ${formatRelative(sweepTask.lastExecution, "ago")}` : ""}) purges pipeline events older than 14 days,
          scan logs older than 7 days, and superseded episode-file rows. These buttons do the same on demand, plus vacuum.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2">
            <div className="font-mono text-xs text-foreground/90">Prune episode history</div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              Drops superseded file rows beyond the latest per episode. Live mappings are never touched.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => start("prune-episode-files")}>
              {busyAction === "prune-episode-files" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Prune
            </Button>
          </div>

          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2">
            <div className="font-mono text-xs text-foreground/90">Purge scan logs</div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              Deletes per-file "mapped file" audit spam. Errors, grabs and other events are kept.
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-[11px]">Keep</span>
              {KEEP_DAY_OPTIONS.map(d => (
                <button
                  key={d}
                  disabled={busy}
                  onClick={() => setKeepDays(d)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${keepDays === d ? "bg-signal/20 text-signal" : "text-muted-foreground hover:text-foreground/80"}`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => start("purge-scan-logs")}>
              {busyAction === "purge-scan-logs" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Purge
            </Button>
          </div>

          <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2">
            <div className="font-mono text-xs text-foreground/90">Vacuum</div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              Rewrites the database file to reclaim space after big purges. Locks the DB for minutes.
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => start("vacuum")}>
              {busyAction === "vacuum" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Vacuum
            </Button>
          </div>
        </div>

        {(jobDetail || jobError) && (
          <p className={`font-mono text-xs ${jobError ? "text-red-400" : "text-signal"}`}>
            {jobError ?? jobDetail}
          </p>
        )}
      </div>
    </GlassPanel>
  );
}

export function AnalyticsPanel() {
  const [data, setData] = React.useState<AnalyticsData | null>(null);
  const [cleanupTask, setCleanupTask] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/system/analytics").then(r => r.json()),
      fetch("/api/tasks").then(r => r.json()).catch(() => []),
    ])
      .then(([analytics, tasks]) => {
        setData(analytics);
        setCleanupTask(Array.isArray(tasks) ? tasks.find((t: any) => t.name === "pipeline-cleanup") : null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }

  React.useEffect(() => { load(); }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-muted-foreground py-8 text-center text-sm">Couldn't load analytics.</p>;
  }

  const totalRows = data.tables.reduce((sum, t) => sum + t.rowCount, 0);
  const sortedTables = [...data.tables].sort((a, b) => b.rowCount - a.rowCount);
  const largestTable = sortedTables[0];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-display text-base font-semibold tracking-wide text-white/90">Database Usage</h3>
          <p className="text-muted-foreground text-xs mt-0.5">
            Row counts, activity, and manual cleanup sweeps — the scan/audit and episode-file history tables are the highest-write ones when scans misbehave.
            {cleanupTask && (
              <> Auto-cleaned {cleanupTask.enabled ? "daily" : "— currently disabled, see Tasks"}, last ran {formatRelative(cleanupTask.lastExecution, "ago")}.</>
            )}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Database Size" value={formatBytes(data.dbSizeBytes)} accent="signal" />
        <StatTile label="Total Rows" value={totalRows.toLocaleString()} />
        <StatTile label="Pipeline Events (24h)" value={data.pipelineEvents.last24h.toLocaleString()} accent="amber" />
        <StatTile label="Oldest Event" value={formatAge(data.pipelineEvents.oldestEventAt)} />
      </div>

      <DatabaseCleanup sweepTask={cleanupTask} onDone={load} />

      <GlassPanel className="p-6 space-y-3">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-signal" />
          <h4 className="font-display text-sm font-semibold text-white/90">Activity, last 24h</h4>
        </div>
        <Sparkline buckets={data.hourlyActivity} />
      </GlassPanel>

      <GlassPanel className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-signal" />
          <h4 className="font-display text-sm font-semibold text-white/90">Pipeline Event Log</h4>
        </div>
        <p className="text-muted-foreground text-xs -mt-2">
          {data.pipelineEvents.total.toLocaleString()} total rows · {data.pipelineEvents.last7d.toLocaleString()} in the last 7 days
        </p>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <div className="text-muted-foreground mb-2 font-mono text-caption uppercase tracking-wider">By stage</div>
            <BreakdownList
              total={data.pipelineEvents.total}
              items={data.pipelineEvents.byStage.map(s => ({
                label: s.stage,
                count: s.count,
                className: STAGE_COLORS[s.stage],
              }))}
            />
          </div>
          <div>
            <div className="text-muted-foreground mb-2 font-mono text-caption uppercase tracking-wider">By reason category</div>
            {data.pipelineEvents.byCategory.length > 0 ? (
              <BreakdownList
                total={data.pipelineEvents.total}
                items={data.pipelineEvents.byCategory.map(c => ({ label: CATEGORY_LABELS[c.category] ?? c.category, count: c.count }))}
              />
            ) : (
              <p className="text-muted-foreground text-xs">No rejections/failures logged yet.</p>
            )}
          </div>
        </div>

        {data.pipelineEvents.byEventType.length > 0 && (
          <div>
            <div className="text-muted-foreground mb-2 font-mono text-caption uppercase tracking-wider">Top event types</div>
            <BreakdownList
              total={data.pipelineEvents.total}
              items={data.pipelineEvents.byEventType.map(e => ({ label: e.eventType, count: e.count }))}
            />
          </div>
        )}
      </GlassPanel>

      {data.noisiestShows.length > 0 && (
        <GlassPanel className="overflow-hidden">
          <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2">
            <FlameIcon className="size-4 text-accent-amber" />
            <h4 className="font-display text-sm font-semibold text-white/90">Noisiest Shows</h4>
          </div>
          <p className="text-muted-foreground px-6 pt-3 text-xs">
            Most pipeline activity — often a sign something's stuck (indexer down, a release repeatedly rejected) rather than just a popular show. Worth checking that item's trace once it's built.
          </p>
          <div className="divide-y divide-white/5 px-6 py-3">
            <BreakdownList
              total={data.noisiestShows[0]?.count ?? 1}
              items={data.noisiestShows.map(s => ({ label: s.showTitle, count: s.count }))}
            />
          </div>
        </GlassPanel>
      )}

      <GlassPanel className="overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2">
          <ArchiveIcon className="size-4 text-signal" />
          <h4 className="font-display text-sm font-semibold text-white/90">Metadata Cache</h4>
        </div>
        <div className="px-6 py-3 flex items-center gap-6 text-xs font-mono">
          <span className="text-foreground/80">{data.cache.total.toLocaleString()} total entries</span>
          <span className="text-muted-foreground">{data.cache.expired.toLocaleString()} expired, awaiting weekly housekeeping sweep</span>
        </div>
      </GlassPanel>

      <GlassPanel className="overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2">
          <DatabaseIcon className="size-4 text-signal" />
          <h4 className="font-display text-sm font-semibold text-white/90">Tables</h4>
        </div>
        <div className="divide-y divide-white/5">
          {sortedTables.map(t => (
            <div key={t.name} className="flex items-center gap-3 px-6 py-2.5">
              <span className="w-48 shrink-0 truncate font-mono text-xs text-foreground/80">{t.name}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-signal/40"
                  style={{ width: largestTable && largestTable.rowCount > 0 ? `${Math.max((t.rowCount / largestTable.rowCount) * 100, 1)}%` : "0%" }}
                />
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">{t.rowCount.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}
