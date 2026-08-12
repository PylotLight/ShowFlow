import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  LayersIcon,
  Loader2Icon,
  SearchIcon,
  FileUpIcon,
  SearchXIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { TraceDialog } from "@frontend/components/showflow/TraceDialog";
import { DiagnoseDialog } from "@frontend/components/showflow/DiagnoseDialog";
import { cn } from "@frontend/lib/utils";
import { groupByShow } from "@frontend/lib/pipelineGrouping";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";

// ── Types ────────────────────────────────────────────────────────────────

interface KanbanEpisode {
  showId: string;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDate: string | null;
  filePath: string | null;
  currentStage: string;
  eventId: number | null;
  eventType: string | null;
  reasonCode: string | null;
  reasonCategory: string | null;
  message: string | null;
  releaseTitle: string | null;
  eventCreatedAt: string | null;
  searchMode: string;
}

interface KanbanLane {
  stage: string;
  label: string;
  items: KanbanEpisode[];
  count: number;
}

interface KanbanResponse {
  lanes: KanbanLane[];
  total: number;
  attentionCount: number;
}

// ── Lane config ──────────────────────────────────────────────────────────

const LANE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  WANTED: ClockIcon,
  SEARCHING: SearchIcon,
  GRABBED: DownloadIcon,
  IMPORTING: FileUpIcon,
  FAILED: AlertCircleIcon,
  AVAILABLE: CheckCircle2Icon,
};

const LANE_COLORS: Record<string, string> = {
  WANTED: "text-muted-foreground border-white/5",
  SEARCHING: "text-blue-400 border-blue-500/20",
  GRABBED: "text-purple-400 border-purple-500/20",
  IMPORTING: "text-accent-amber border-accent-amber/20",
  FAILED: "text-destructive border-destructive/20",
  AVAILABLE: "text-emerald-400 border-emerald-500/20",
};

const LANE_BG: Record<string, string> = {
  WANTED: "bg-white/[0.01]",
  SEARCHING: "bg-blue-500/[0.03]",
  GRABBED: "bg-purple-500/[0.03]",
  IMPORTING: "bg-accent-amber/[0.03]",
  FAILED: "bg-destructive/[0.03]",
  AVAILABLE: "bg-emerald-500/[0.03]",
};

const STAGE_ORDER = ["WANTED", "SEARCHING", "GRABBED", "IMPORTING", "FAILED", "AVAILABLE"];

// ── Helpers ──────────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function formatAirDate(iso: string | null): string {
  if (!iso) return "TBA";
  const date = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays < 0) return `in ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function epKey(ep: KanbanEpisode): string {
  return `${ep.showId}-${ep.seasonNumber}-${ep.episodeNumber}`;
}

// ── Sub-components ────────────────────────────────────────────────────────

function StageBadge({ stage, small }: { stage: string; small?: boolean }) {
  const color = LANE_COLORS[stage] ?? "text-muted-foreground";
  const bg = stage === "FAILED"
    ? "bg-destructive/15 border-destructive/10"
    : stage === "AVAILABLE"
    ? "bg-emerald-500/15 border-emerald-500/10"
    : stage === "GRABBED"
    ? "bg-purple-500/15 border-purple-500/10"
    : stage === "IMPORTING"
    ? "bg-accent-amber/15 border-accent-amber/10"
    : stage === "SEARCHING"
    ? "bg-blue-500/15 border-blue-500/10"
    : "bg-white/5 border-white/5";
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-mono border", bg, color, small ? "text-[9px]" : "text-[10px]")}>
      {stage === "AVAILABLE" ? "On disk" : stage}
    </span>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────

function KanbanCard({
  ep,
  index,
  onSearch,
  onGrab,
  onTrace,
  onDiagnose,
  grabbing,
  grabbed,
}: {
  ep: KanbanEpisode;
  index: number;
  onSearch: () => void;
  onGrab: () => void;
  onTrace: () => void;
  onDiagnose: () => void;
  grabbing: boolean;
  grabbed: boolean;
}) {
  const showGrab = ep.currentStage === "WANTED" || ep.currentStage === "SEARCHING";
  const showDiagnose = ep.currentStage === "FAILED";
  const showTrace = ep.currentStage !== "WANTED" && ep.currentStage !== "AVAILABLE";

  return (
    <div
      className={cn(
        "rounded-lg border glass-panel p-3 space-y-2 transition-all duration-200",
        "hover:border-white/15 hover:bg-white/[0.04]",
        "animate-fade-in",
      )}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
    >
      {/* Top row: poster + info */}
      <div className="flex gap-2.5">
        <PosterImage showId={ep.showId} alt={ep.showTitle} className="w-8 h-12 shrink-0 rounded" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-xs font-semibold text-white/90" title={ep.showTitle}>
            {ep.showTitle}
          </p>
          <EpisodeChip season={ep.seasonNumber} episode={ep.episodeNumber} state="none" className="text-[11px]" />
          {ep.episodeTitle && (
            <p className="truncate text-[10px] text-muted-foreground">{ep.episodeTitle}</p>
          )}
          <p className="text-[10px] text-muted-foreground/70">
            {formatAirDate(ep.airDate)}
          </p>
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2">
        <StageBadge stage={ep.currentStage} small />
        {ep.eventCreatedAt && ep.currentStage !== "AVAILABLE" && (
          <span className="text-[9px] text-muted-foreground/60 font-mono">
            {formatRelative(ep.eventCreatedAt)}
          </span>
        )}
        {ep.currentStage === "AVAILABLE" && ep.filePath && (
          <span className="text-[9px] text-emerald-400/60 font-mono truncate" title={ep.filePath}>
            {ep.filePath.split(/[\\/]/).pop()}
          </span>
        )}
      </div>

      {/* Message */}
      {ep.message && ep.currentStage !== "AVAILABLE" && (
        <p className="text-[10px] text-muted-foreground/80 truncate leading-relaxed" title={ep.message}>
          {ep.message}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 pt-0.5">
        {showGrab && (
          <Button size="sm" variant={grabbed ? "outline" : "default"} onClick={onGrab} disabled={grabbing} className="h-6 px-2 text-[10px]">
            {grabbing ? <Loader2Icon className="size-2.5 animate-spin" /> : grabbed ? <CheckIcon className="size-2.5" /> : <DownloadIcon className="size-2.5" />}
            {grabbed ? "Sent" : "Grab"}
          </Button>
        )}
        {showTrace && (
          <Button size="sm" variant="outline" onClick={onTrace} className="h-6 px-2 text-[10px]">
            Trace
          </Button>
        )}
        {showDiagnose && (
          <Button size="sm" variant="outline" onClick={onDiagnose} className="h-6 px-2 text-[10px]">
            Diagnose
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onSearch} className="h-6 px-2 text-[10px] ml-auto">
          <SearchIcon className="size-2.5" />
          Search
        </Button>
      </div>
    </div>
  );
}

// ── Grouped lane items ────────────────────────────────────────────────────

function GroupedLaneItems({ items, expandedShows, onToggleShow, grabbing, grabbedKeys, onSearch, onGrab, onTrace, onDiagnose, onShowSelect, shows }: {
  items: KanbanEpisode[];
  expandedShows: Set<string>;
  onToggleShow: (showId: string) => void;
  grabbing: string | null;
  grabbedKeys: Set<string>;
  onSearch: (ep: KanbanEpisode) => void;
  onGrab: (ep: KanbanEpisode) => void;
  onTrace: (ep: KanbanEpisode) => void;
  onDiagnose: (ep: KanbanEpisode) => void;
  onShowSelect: (show: ShowSummary | null) => void;
  shows: ShowSummary[];
}) {
  const groups = groupByShow(items);

  return (
    <div className="space-y-2">
      {groups.map(group => {
        const expanded = expandedShows.has(group.showId);
        const count = group.items.length;
        const show = shows.find(s => s.id === group.showId);
        return (
          <div key={group.showId}>
            <div className="flex items-center gap-2 rounded-lg border glass-panel p-2.5 text-left hover:border-white/15 hover:bg-white/[0.04] transition-all">
              <button
                type="button"
                onClick={() => show && onShowSelect(show)}
                title="Open show"
                className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
              >
                <PosterImage showId={group.showId} alt={group.showTitle} className="w-7 h-10 shrink-0 rounded" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-xs font-semibold text-white/90">{group.showTitle}</p>
                  <p className="text-[10px] text-muted-foreground/70">
                    {count} episode{count !== 1 ? "s" : ""}
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onToggleShow(group.showId)}
                title={expanded ? "Collapse" : "Expand"}
                className="font-mono text-[10px] text-muted-foreground/60 shrink-0 p-1 rounded hover:bg-white/10"
              >
                {expanded ? "−" : "+"}
              </button>
            </div>
            {expanded && (
              <div className="space-y-2 pl-2 mt-2">
                {group.items.map((ep, i) => (
                  <KanbanCard
                    key={epKey(ep)}
                    ep={ep}
                    index={i}
                    grabbing={grabbing === epKey(ep)}
                    grabbed={grabbedKeys.has(epKey(ep))}
                    onSearch={() => onSearch(ep)}
                    onGrab={() => onGrab(ep)}
                    onTrace={() => onTrace(ep)}
                    onDiagnose={() => onDiagnose(ep)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Lane column ───────────────────────────────────────────────────────────

function KanbanLaneColumn({ lane, shows, onShowSelect, grabbing, grabbedKeys, onSearch, onTrace, onDiagnose, onGrab, expandedShows, onToggleShow }: {
  lane: KanbanLane;
  shows: ShowSummary[];
  onShowSelect: (show: ShowSummary | null) => void;
  grabbing: string | null;
  grabbedKeys: Set<string>;
  onSearch: (ep: KanbanEpisode) => void;
  onTrace: (ep: KanbanEpisode) => void;
  onDiagnose: (ep: KanbanEpisode) => void;
  onGrab: (ep: KanbanEpisode) => void;
  expandedShows: Set<string>;
  onToggleShow: (showId: string) => void;
}) {
  const Icon = LANE_ICONS[lane.stage] ?? LayersIcon;
  const color = LANE_COLORS[lane.stage] ?? "";
  const bg = LANE_BG[lane.stage] ?? "";

  return (
    <div className={cn("flex flex-col shrink-0 w-[280px] max-h-full", "max-md:w-full")}>
      {/* Column header */}
      <div className={cn("flex items-center gap-2 px-3 py-2.5 mb-2 rounded-lg border", bg, color)}>
        <Icon className="size-3.5 shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider">{lane.label}</span>
        <span className={cn("ml-auto font-mono text-[10px] opacity-60", color)}>{lane.count}</span>
      </div>

      {/* Cards */}
      <div className="space-y-2 overflow-y-auto pr-1 flex-1 min-h-0">
        {lane.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/40">
            <SearchXIcon className="size-5 mb-1" />
            <p className="text-[10px]">Empty</p>
          </div>
        ) : (
          <GroupedLaneItems
            items={lane.items}
            expandedShows={expandedShows}
            onToggleShow={onToggleShow}
            grabbing={grabbing}
            grabbedKeys={grabbedKeys}
            onSearch={onSearch}
            onGrab={onGrab}
            onTrace={onTrace}
            onDiagnose={onDiagnose}
            onShowSelect={onShowSelect}
            shows={shows}
          />
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

function PipelineKanban({ onSelectShow }: { onSelectShow?: (show: ShowSummary | null) => void }) {
  const [data, setData] = React.useState<KanbanResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [shows, setShows] = React.useState<ShowSummary[]>([]);
  const [grabbing, setGrabbing] = React.useState<string | null>(null);
  const [grabbedKeys, setGrabbedKeys] = React.useState<Set<string>>(new Set());
  const [grabMsg, setGrabMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [searchTarget, setSearchTarget] = React.useState<KanbanEpisode | null>(null);
  const [traceTarget, setTraceTarget] = React.useState<KanbanEpisode | null>(null);
  const [diagnoseTarget, setDiagnoseTarget] = React.useState<KanbanEpisode | null>(null);
  const [expandedShows, setExpandedShows] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(() => {
    Promise.all([
      fetch("/api/pipeline/kanban").then(r => r.json()).then(d => {
        setData(d);
        setError(null);
      }).catch(() => setError("Failed to load pipeline data")),
      fetch("/api/shows").then(r => r.json()).then(setShows).catch(() => {}),
    ]);
  }, []);

  React.useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  React.useEffect(() => {
    if (!grabMsg) return;
    const t = setTimeout(() => setGrabMsg(null), 4000);
    return () => clearTimeout(t);
  }, [grabMsg]);

  function findShow(showId: string) {
    return shows.find(s => s.id === showId);
  }

  function toggleShowGroup(showId: string) {
    setExpandedShows(prev => {
      const next = new Set(prev);
      if (next.has(showId)) next.delete(showId);
      else next.add(showId);
      return next;
    });
  }

  async function handleGrab(ep: KanbanEpisode) {
    const k = epKey(ep);
    setGrabbing(k);
    try {
      const res = await fetch(`/api/shows/${ep.showId}/seasons/${ep.seasonNumber}/episodes/${ep.episodeNumber}/grab`, { method: "POST" });
      const result = await res.json();
      const ok = !!result.success;
      setGrabMsg({ ok, text: result.message || (ok ? `Grabbed "${ep.showTitle}" S${ep.seasonNumber}E${ep.episodeNumber}` : "No matching release found") });
      if (ok) setGrabbedKeys(prev => new Set(prev).add(k));
    } catch {
      setGrabMsg({ ok: false, text: "Grab failed — check your indexer connection" });
    } finally {
      setGrabbing(null);
    }
  }

  // Sort lanes by STAGE_ORDER
  const lanes = React.useMemo(() => {
    if (!data) return [];
    const laneMap = new Map(data.lanes.map(l => [l.stage, l]));
    return STAGE_ORDER
      .filter(s => laneMap.has(s))
      .map(s => laneMap.get(s)!);
  }, [data]);

  const attentionCount = data?.attentionCount ?? 0;
  const total = data?.total ?? 0;

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header summary */}
      <GlassPanel className="flex items-center justify-between p-4 shrink-0">
        <div className="flex items-center gap-3">
          <LayersIcon className="size-5 text-signal" />
          <div>
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Pipeline</span>
            <h2 className="font-display text-2xl font-bold text-white mt-0.5">
              {data === null ? "—" : total} tracked episode{total !== 1 ? "s" : ""}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {attentionCount > 0 && (
            <span className="rounded-full bg-accent-amber/15 border border-accent-amber/20 px-3 py-1 text-[11px] font-mono text-accent-amber">
              {attentionCount} need{attentionCount !== 1 ? "" : "s"} attention
            </span>
          )}
          {grabMsg && (
            <span className={cn("text-xs", grabMsg.ok ? "text-emerald-400" : "text-red-400")}>
              {grabMsg.text}
            </span>
          )}
        </div>
      </GlassPanel>

      {/* Kanban lanes */}
      {error ? (
        <GlassPanel className="flex items-center justify-center py-16">
          <div className="text-center space-y-2">
            <AlertCircleIcon className="size-6 text-destructive mx-auto" />
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={load} className="mt-2">Retry</Button>
          </div>
        </GlassPanel>
      ) : data === null ? (
        <div className="flex items-center justify-center py-24">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : lanes.length === 0 ? (
        <GlassPanel className="flex items-center justify-center py-16">
          <div className="text-center space-y-2">
            <CheckCircle2Icon className="size-8 text-emerald-400 mx-auto mb-2" />
            <h3 className="font-display text-lg font-bold text-white">All clear</h3>
            <p className="text-sm text-muted-foreground">No tracked episodes in the pipeline.</p>
          </div>
        </GlassPanel>
      ) : (
        <div className="flex-1 min-h-0">
          {/* Desktop: horizontal scroll columns */}
          <div className="hidden md:flex gap-4 h-full overflow-x-auto pb-2 snap-x snap-mandatory">
            {lanes.map(lane => (
              <div key={lane.stage} className="snap-start h-full">
                <KanbanLaneColumn
                  lane={lane}
                  shows={shows}
                  onShowSelect={onSelectShow ?? (() => {})}
                  grabbing={grabbing}
                  grabbedKeys={grabbedKeys}
                  onSearch={setSearchTarget}
                  onTrace={setTraceTarget}
                  onDiagnose={setDiagnoseTarget}
                  onGrab={handleGrab}
                  expandedShows={expandedShows}
                  onToggleShow={toggleShowGroup}
                />
              </div>
            ))}
          </div>

          {/* Mobile: vertical stacked sections */}
          <div className="md:hidden space-y-4 pb-4">
            {lanes.map((lane, li) => (
              <div key={lane.stage} className="animate-fade-in" style={{ animationDelay: `${li * 50}ms` }}>
                <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border mb-2", LANE_BG[lane.stage] ?? "", LANE_COLORS[lane.stage] ?? "")}>
                  {LANE_ICONS[lane.stage] && React.createElement(LANE_ICONS[lane.stage]!, { className: "size-3.5 shrink-0" })}
                  <span className="text-xs font-semibold uppercase tracking-wider">{lane.label}</span>
                  <span className={cn("ml-auto font-mono text-[10px] opacity-60", LANE_COLORS[lane.stage])}>{lane.count}</span>
                </div>
                <GroupedLaneItems
                  items={lane.items}
                  expandedShows={expandedShows}
                  onToggleShow={toggleShowGroup}
                  grabbing={grabbing}
                  grabbedKeys={grabbedKeys}
                  onSearch={setSearchTarget}
                  onGrab={handleGrab}
                  onTrace={setTraceTarget}
                  onDiagnose={setDiagnoseTarget}
                  onShowSelect={onSelectShow ?? (() => {})}
                  shows={shows}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dialogs */}
      {searchTarget && (
        <ReleaseSearchDialog
          open={!!searchTarget}
          onOpenChange={(open) => { if (!open) setSearchTarget(null); }}
          showId={searchTarget.showId}
          showTitle={searchTarget.showTitle}
          season={searchTarget.seasonNumber}
          episode={searchTarget.episodeNumber}
          onGrabbed={(message, success) => {
            setGrabMsg({ ok: success, text: message });
            setGrabbedKeys(prev => new Set(prev).add(epKey(searchTarget)));
          }}
        />
      )}

      {traceTarget && (
        <TraceDialog
          open={!!traceTarget}
          onOpenChange={(open) => { if (!open) setTraceTarget(null); }}
          showId={traceTarget.showId}
          showTitle={traceTarget.showTitle}
          season={traceTarget.seasonNumber}
          episode={traceTarget.episodeNumber}
        />
      )}

      {diagnoseTarget && (
        <DiagnoseDialog
          open={!!diagnoseTarget}
          onOpenChange={(open) => { if (!open) setDiagnoseTarget(null); }}
          showId={diagnoseTarget.showId}
          showTitle={diagnoseTarget.showTitle}
          season={diagnoseTarget.seasonNumber}
          episode={diagnoseTarget.episodeNumber}
        />
      )}
    </div>
  );
}

export { PipelineKanban };
export type { KanbanEpisode, KanbanLane, KanbanResponse };
