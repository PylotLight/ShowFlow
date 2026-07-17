import { AlertCircleIcon, CheckIcon, DownloadIcon, Loader2Icon, SearchIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { TraceDialog } from "@frontend/components/showflow/TraceDialog";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

interface MissingEpisode {
  showId: string;
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string;
  searchMode: string;
}

function formatAirDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function EpisodeRow({
  ep,
  onSearch,
  onGrab,
  onTrace,
  grabbing,
  grabbed,
}: {
  ep: MissingEpisode;
  onSearch: () => void;
  onGrab: () => void;
  onTrace: () => void;
  grabbing: boolean;
  grabbed: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
      <EpisodeChip season={ep.season} episode={ep.episode} state="none" className="shrink-0 w-16" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground/85">{ep.episodeTitle || `Episode ${ep.episode}`}</p>
      </div>
      <span className="shrink-0 font-mono text-caption text-muted-foreground w-16 text-right">
        {formatAirDate(ep.airDate)}
      </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant={grabbed ? "outline" : "default"}
            onClick={onGrab}
            disabled={grabbing}
            className="h-7 px-2 text-xs"
          >
            {grabbing ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : grabbed ? (
              <CheckIcon className="size-3" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
            {grabbed ? "Grabbed" : "Auto"}
          </Button>
          <Button size="sm" variant="outline" onClick={onTrace} className="h-7 px-2 text-xs">
            Trace
          </Button>
          <Button size="sm" variant="outline" onClick={onSearch} className="h-7 px-2 text-xs">
            <SearchIcon className="size-3" />
            Search
          </Button>
        </div>
    </div>
  );
}

function MissingPage({ onSelectShow }: { onSelectShow: (show: ShowSummary) => void }) {
  const [episodes, setEpisodes] = React.useState<MissingEpisode[] | null>(null);
  const [shows, setShows] = React.useState<ShowSummary[]>([]);
  const [grabbing, setGrabbing] = React.useState<string | null>(null);
  const [grabbedKeys, setGrabbedKeys] = React.useState<Set<string>>(new Set());
  const [grabMsg, setGrabMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [searchTarget, setSearchTarget] = React.useState<MissingEpisode | null>(null);
  const [traceTarget, setTraceTarget] = React.useState<MissingEpisode | null>(null);

  const load = React.useCallback(() => {
    fetch("/api/missing")
      .then((r) => r.json())
      .then((data: MissingEpisode[]) => setEpisodes(Array.isArray(data) ? data : []))
      .catch(() => setEpisodes([]));
  }, []);

  React.useEffect(() => {
    load();
    fetch("/api/shows").then((r) => r.json()).then(setShows).catch(() => setShows([]));
  }, [load]);

  React.useEffect(() => {
    if (!grabMsg) return;
    const t = setTimeout(() => setGrabMsg(null), 4000);
    return () => clearTimeout(t);
  }, [grabMsg]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, MissingEpisode[]>();
    for (const ep of episodes ?? []) {
      if (!map.has(ep.showId)) map.set(ep.showId, []);
      map.get(ep.showId)!.push(ep);
    }
    return [...map.entries()].sort((a, b) => (a[1][0]?.showTitle ?? '').localeCompare(b[1][0]?.showTitle ?? ''));
  }, [episodes]);

  function epKey(ep: MissingEpisode) {
    return `${ep.showId}-${ep.season}-${ep.episode}`;
  }

  async function handleGrab(ep: MissingEpisode) {
    const k = epKey(ep);
    setGrabbing(k);
    try {
      const res = await fetch(`/api/shows/${ep.showId}/seasons/${ep.season}/episodes/${ep.episode}/grab`, {
        method: "POST",
      });
      const data = await res.json();
      const ok = !!data.success;
      setGrabMsg({ ok, text: data.message || (ok ? `Grabbed "${ep.showTitle}" S${ep.season}E${ep.episode}` : "No matching release found") });
      if (ok) setGrabbedKeys((prev) => new Set(prev).add(k));
    } catch {
      setGrabMsg({ ok: false, text: "Grab failed — check your indexer connection" });
    } finally {
      setGrabbing(null);
    }
  }

  function findShow(id: string) {
    return shows.find((s) => s.id === id);
  }

  const totalMissing = episodes?.length ?? 0;

  return (
    <div className="space-y-4">
      <GlassPanel className="flex items-center justify-between p-5">
        <div>
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">// Missing</span>
          <h2 className="font-display text-2xl font-bold text-white mt-0.5">
            {episodes === null ? "—" : totalMissing} episode{totalMissing !== 1 ? "s" : ""} unaccounted for
          </h2>
          <p className="text-muted-foreground text-xs mt-1">
            Tracked episodes that have aired but don&rsquo;t have a file on disk yet.
          </p>
        </div>
        {grabMsg && (
          <span className={cn("flex items-center gap-1.5 text-xs shrink-0", grabMsg.ok ? "text-emerald-400" : "text-red-400")}>
            {grabMsg.ok ? <CheckIcon className="size-3.5" /> : <AlertCircleIcon className="size-3.5" />}
            {grabMsg.text}
          </span>
        )}
      </GlassPanel>

      {episodes === null ? (
        <div className="flex items-center justify-center py-24">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : grouped.length === 0 ? (
        <GlassPanel className="p-10 text-center">
          <CheckIcon className="size-8 text-emerald-400 mx-auto mb-3" />
          <h3 className="font-display text-lg font-bold text-white mb-1">All caught up</h3>
          <p className="text-muted-foreground text-sm">Every tracked, aired episode has a file.</p>
        </GlassPanel>
      ) : (
        <div className="space-y-4">
          {grouped.map(([showId, eps]) => {
            const show = findShow(showId);
            return (
              <GlassPanel key={showId} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => show && onSelectShow(show)}
                  className="flex w-full items-center gap-3 px-4 py-3 border-b border-white/5 text-left hover:bg-white/[0.02] transition-colors"
                >
                  {show ? (
                    <PosterImage showId={show.id} alt={eps[0]!.showTitle} className="w-8 h-12 shrink-0 rounded" />
                  ) : (
                    <div className="w-8 h-12 shrink-0 rounded bg-white/[0.03] border border-white/5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-base font-semibold text-white truncate">{eps[0]!.showTitle}</h3>
                    <p className="text-muted-foreground text-xs">{eps.length} missing episode{eps.length !== 1 ? "s" : ""}</p>
                  </div>
                </button>
                <div className="divide-y divide-white/5">
                  {eps.map((ep) => {
                    const k = epKey(ep);
                    return (
                      <EpisodeRow
                        key={k}
                        ep={ep}
                        onSearch={() => setSearchTarget(ep)}
                        onGrab={() => handleGrab(ep)}
                        onTrace={() => setTraceTarget(ep)}
                        grabbing={grabbing === k}
                        grabbed={grabbedKeys.has(k)}
                      />
                    );
                  })}
                </div>
              </GlassPanel>
            );
          })}
        </div>
      )}

      {searchTarget && (
        <ReleaseSearchDialog
          open={!!searchTarget}
          onOpenChange={(open) => { if (!open) setSearchTarget(null); }}
          showId={searchTarget.showId}
          showTitle={searchTarget.showTitle}
          season={searchTarget.season}
          episode={searchTarget.episode}
          onGrabbed={(message) => {
            setGrabMsg({ ok: !message.toLowerCase().includes("fail"), text: message });
            setGrabbedKeys((prev) => new Set(prev).add(epKey(searchTarget)));
          }}
        />
      )}

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

export { MissingPage };
