import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileCheckIcon,
  HistoryIcon,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import { TraceDialog } from "@frontend/components/showflow/TraceDialog";
import { navigate } from "@frontend/lib/router";
import { notify } from "@frontend/lib/toast";
import { usePolling, setIfChanged } from "@frontend/lib/usePolling";
import { cn } from "@frontend/lib/utils";
import {
  ACTION_LABEL,
  STATE_CHIP,
  STATE_LABEL,
  epCode,
  formatAge,
  runExplainAction,
  type AttentionPage,
  type ExplainedEpisode,
} from "@frontend/lib/pipelineStatus";

const PAGE_SIZE = 50;

function itemKey(e: ExplainedEpisode) {
  return `${e.showId}:${e.season}:${e.episode}`;
}

function openShow(showId: string) {
  navigate(`#/show/${encodeURIComponent(showId)}`, { state: { sfFromApp: true } });
}

function StateChip({ item }: { item: ExplainedEpisode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide whitespace-nowrap", STATE_CHIP[item.state])}>
      {(item.state === "searching" || item.state === "importing") && <Loader2Icon className="size-3 animate-spin" aria-hidden />}
      {STATE_LABEL[item.state]}
    </span>
  );
}

function AttentionRow({
  item,
  busy,
  onAction,
  onTrace,
}: {
  item: ExplainedEpisode;
  busy: boolean;
  onAction: () => void;
  onTrace: () => void;
}) {
  const age = formatAge(item.waitingSince);
  const isUpcoming = item.state === "waiting_air";
  return (
    <li className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-3 hover:bg-white/[0.03] transition-colors">
      <PosterImage showId={item.showId} alt="" size="card" className="w-8 h-12 shrink-0 rounded max-sm:hidden" />
      <div className="min-w-0 flex-1 max-sm:basis-full space-y-1">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <button
            type="button"
            onClick={() => openShow(item.showId)}
            className="truncate text-sm font-semibold text-foreground hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded max-w-full"
            title={`Open ${item.showTitle}`}
          >
            {item.showTitle}
          </button>
          {!item.isMovie && <EpisodeChip season={item.season} episode={item.episode} state="tracked" className="text-[11px] text-muted-foreground" />}
          {item.isMovie && <span className="font-mono text-[11px] text-muted-foreground">Movie</span>}
          <StateChip item={item} />
        </div>
        <p className="text-[13px] leading-snug text-foreground/85" title={item.releaseTitle ?? undefined}>
          {item.detail}
        </p>
        {item.progress != null && item.state === "grabbed_downloading" && (
          <div className="h-1 w-full max-w-xs rounded bg-white/10 overflow-hidden" role="progressbar" aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
            <div className="h-full bg-purple-400" style={{ width: `${item.progress}%` }} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0 max-sm:w-full max-sm:justify-between">
      <div className="text-right shrink-0 w-20 max-sm:w-auto max-sm:text-left max-sm:flex max-sm:items-baseline max-sm:gap-1">
        <div className="font-mono text-[12px] text-foreground/80 tabular-nums">{isUpcoming ? "—" : age ?? "—"}</div>
        <div className="text-[11px] text-muted-foreground">{isUpcoming ? "upcoming" : "waiting"}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {item.action && item.action !== "open_show" ? (
          <Button size="sm" variant={item.state === "stuck" ? "default" : "outline"} onClick={onAction} disabled={busy} className="h-7 px-2.5 text-[12px]">
            {busy && <Loader2Icon className="size-3 animate-spin" />}
            {ACTION_LABEL[item.action]}
          </Button>
        ) : null}
        {!item.isMovie && (
          <Button size="sm" variant="ghost" onClick={onTrace} aria-label={`Trace ${item.showTitle} ${epCode(item.season, item.episode)}`} title="Event trace" className="h-7 w-7 p-0">
            <HistoryIcon className="size-3.5" />
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openShow(item.showId)} aria-label={`Open ${item.showTitle}`} title="Open show" className="h-7 w-7 p-0">
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
      </div>
    </li>
  );
}

interface RecentImport {
  id: string;
  timestamp: string;
  showId: string | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

function RecentImports() {
  const [items, setItems] = React.useState<RecentImport[] | null>(null);
  const setItemsIfChanged = React.useMemo(() => setIfChanged(setItems), []);
  usePolling(() => {
    fetch("/api/history?kind=import&limit=8")
      .then(r => r.json())
      .then(d => setItemsIfChanged(d.items ?? []))
      .catch(() => {});
  }, 60_000);
  if (!items || items.length === 0) return null;
  return (
    <GlassPanel className="p-4">
      <h3 className="mb-2 flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-widest text-emerald-300">
        <FileCheckIcon className="size-3.5" /> Recent imports
      </h3>
      <ul className="flex flex-wrap gap-2">
        {items.map(it => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => it.showId && openShow(it.showId)}
              className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[12px] text-foreground/85 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              <span className="max-w-[12rem] truncate">{it.showTitle ?? "Unknown"}</span>
              {it.seasonNumber != null && it.episodeNumber != null && it.seasonNumber + it.episodeNumber > 0 && (
                <span className="font-mono text-[11px] text-muted-foreground">{epCode(it.seasonNumber, it.episodeNumber)}</span>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">{formatAge(it.timestamp)} ago</span>
            </button>
          </li>
        ))}
      </ul>
    </GlassPanel>
  );
}

/**
 * "Needs attention": every episode the pipeline hasn't finished, each with
 * a plain-English reason from /api/pipeline/attention (core/pipeline/
 * explain.ts) and one click to fix it. Oldest wait first.
 */
function PipelineAttention({ onTotal }: { onTotal?: (total: number) => void }) {
  const [page, setPage] = React.useState<AttentionPage | null>(null);
  const [limit, setLimit] = React.useState(PAGE_SIZE);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [traceTarget, setTraceTarget] = React.useState<ExplainedEpisode | null>(null);
  const setPageIfChanged = React.useMemo(() => setIfChanged(setPage), []);

  const load = React.useCallback(() => {
    fetch(`/api/pipeline/attention?limit=${limit}`)
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d: AttentionPage) => {
        setPageIfChanged(d);
        setError(null);
      })
      .catch(() => setError("Couldn't load the pipeline"));
  }, [limit, setPageIfChanged]);

  usePolling(load, 15_000);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    // usePolling already fired the first load; refetch only when the page size grows.
    if (!mounted.current) { mounted.current = true; return; }
    load();
  }, [load]);
  React.useEffect(() => { if (page) onTotal?.(page.total); }, [page, onTotal]);

  async function act(item: ExplainedEpisode) {
    if (item.action === "open_show") return openShow(item.showId);
    const k = itemKey(item);
    setBusy(k);
    const res = await runExplainAction(item);
    notify(res.ok, res.message);
    setBusy(null);
    load();
  }

  if (error && !page) {
    return (
      <GlassPanel className="flex items-center justify-center py-16">
        <div className="text-center space-y-2">
          <AlertCircleIcon className="size-6 text-destructive mx-auto" />
          <p className="text-sm text-red-300">{error}</p>
          <Button size="sm" variant="outline" onClick={load}>Retry</Button>
        </div>
      </GlassPanel>
    );
  }
  if (!page) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {page.items.length === 0 ? (
        <GlassPanel className="flex items-center justify-center py-16">
          <div className="text-center space-y-2">
            <CheckCircle2Icon className="size-8 text-emerald-400 mx-auto mb-2" />
            <h3 className="font-display text-lg font-bold text-white">All clear</h3>
            <p className="text-sm text-muted-foreground">Nothing is waiting on the pipeline.</p>
          </div>
        </GlassPanel>
      ) : (
        <GlassPanel className="p-0 overflow-hidden">
          <ul className="divide-y divide-white/5">
            {page.items.map(item => (
              <AttentionRow
                key={itemKey(item)}
                item={item}
                busy={busy === itemKey(item)}
                onAction={() => act(item)}
                onTrace={() => setTraceTarget(item)}
              />
            ))}
          </ul>
          {page.hasMore && (
            <div className="border-t border-white/5 p-3 text-center">
              <Button size="sm" variant="outline" onClick={() => setLimit(l => l + PAGE_SIZE)}>
                Show more ({page.total - page.items.length} left)
              </Button>
            </div>
          )}
        </GlassPanel>
      )}

      <RecentImports />

      {traceTarget && (
        <TraceDialog
          open={!!traceTarget}
          onOpenChange={(open) => { if (!open) setTraceTarget(null); }}
          showId={traceTarget.showId}
          showTitle={traceTarget.showTitle}
          season={traceTarget.season}
          episode={traceTarget.episode}
        />
      )}
    </div>
  );
}

export { PipelineAttention };
