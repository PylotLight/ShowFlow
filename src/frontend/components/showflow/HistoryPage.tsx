import {
  DownloadIcon, FileCheckIcon, InfoIcon, SearchIcon, RefreshCwIcon,
  AlertTriangleIcon, XCircleIcon, ChevronDownIcon,
} from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { HeaderActions } from "@frontend/lib/header-actions";
import { formatImportDate } from "@frontend/lib/airtime";
import { cn } from "@frontend/lib/utils";

type HistoryKind = "grab" | "import" | "event";

interface HistoryItem {
  id: string;
  kind: HistoryKind;
  timestamp: string;
  showId: string | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  stage: string | null;
  eventType: string | null;
  message: string;
  releaseTitle: string | null;
  indexerName: string | null;
}

const PAGE_SIZE = 50;

function kindIcon(kind: HistoryKind, stage: string | null) {
  if (kind === "grab") return <DownloadIcon className="size-4 shrink-0 text-signal" />;
  if (kind === "import") return <FileCheckIcon className="size-4 shrink-0 text-emerald-400" />;
  if (stage === "FAILED") return <XCircleIcon className="size-4 shrink-0 text-red-400" />;
  if (stage === "WANTED") return <AlertTriangleIcon className="size-4 shrink-0 text-accent-amber" />;
  return <InfoIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function epLabel(season: number | null, episode: number | null): string | null {
  if (season == null || episode == null) return null;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

const KIND_TABS = [
  { id: "all", label: "All" },
  { id: "grab", label: "Grabs" },
  { id: "import", label: "Imports" },
  { id: "event", label: "Events" },
] as const;

type KindTab = (typeof KIND_TABS)[number]["id"];

export function HistoryPage() {
  const [items, setItems] = React.useState<HistoryItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [kind, setKind] = React.useState<KindTab>("all");
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = React.useCallback(async (offset: number, append: boolean) => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (kind !== "all") params.set("kind", kind);
    if (debouncedQuery) params.set("q", debouncedQuery);
    const res = await fetch(`/api/history?${params.toString()}`);
    if (!res.ok) throw new Error("history fetch failed");
    return (await res.json()) as { items: HistoryItem[]; hasMore: boolean };
  }, [kind, debouncedQuery]);

  const refresh = React.useCallback(async () => {
    try {
      const data = await fetchPage(0, false);
      setItems(data.items);
      setHasMore(data.hasMore);
    } catch {
      // Keep stale list on transient failure; polling retries shortly.
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  // Reset to the first page whenever the filters change.
  React.useEffect(() => {
    setLoading(true);
    setItems([]);
    setHasMore(false);
    refresh();
  }, [refresh]);

  // Poll the first page so new grabs/imports appear live — but never while
  // the user has paged deeper (that would clobber the appended list).
  React.useEffect(() => {
    if (hasMore) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh, hasMore]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(items.length, true);
      setItems((prev) => [...prev, ...data.items]);
      setHasMore(data.hasMore);
    } catch {
      // Transient failure — the button stays so the user can retry.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="h-full flex flex-col gap-6">
      <HeaderActions>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1">
            {KIND_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setKind(t.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-all",
                  kind === t.id
                    ? "bg-signal/15 text-signal font-semibold"
                    : "text-muted-foreground hover:text-foreground bg-white/[0.03] hover:bg-white/[0.06]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <input
              placeholder="Filter history..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-44 sm:w-56 rounded-md bg-white/5 border border-white/5 pl-8 pr-2 text-xs placeholder:text-muted-foreground/60 focus:border-signal/50 focus:outline-none focus:ring-1 focus:ring-signal/30"
            />
          </div>
          <button
            onClick={() => { setLoading(true); refresh(); }}
            title="Refresh history"
            className="flex items-center justify-center size-8 rounded-md border border-white/5 bg-white/[0.02] text-white/70 hover:text-white hover:bg-white/[0.06] transition-all"
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </button>
        </div>
      </HeaderActions>

      <GlassPanel className="flex flex-col overflow-hidden flex-1 min-h-0">
        <div className="border-b border-white/5 px-5 py-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-bold text-white mt-0.5 leading-tight">
              History
            </h2>
            {!loading && (
              <div className="text-right font-mono text-xs text-muted-foreground">
                <span className="text-white font-semibold">{items.length}</span>
                {" "}event{items.length !== 1 && "s"}
                {hasMore && <span className="text-white/60"> — more below</span>}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading && items.length === 0 ? (
            <div className="p-5 space-y-2">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2 animate-pulse">
                  <div className="size-4 rounded-full bg-white/10 shrink-0" />
                  <div className="h-3.5 flex-1 max-w-[260px] rounded bg-white/10" />
                  <div className="h-3 w-24 rounded bg-white/5 shrink-0 ml-auto" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground text-xs font-mono">
              {debouncedQuery || kind !== "all"
                ? "NO HISTORY MATCHES THESE FILTERS."
                : "NO GRABS OR IMPORTS YET — HISTORY APPEARS HERE AS THE APP DOWNLOADS."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {items.map((it) => {
                const ep = epLabel(it.seasonNumber, it.episodeNumber);
                return (
                  <div
                    key={it.id}
                    className="group flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-2 py-1.5 transition-all duration-150 hover:bg-white/[0.03]"
                  >
                    {kindIcon(it.kind, it.stage)}
                    <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      {it.showTitle && (
                        <span
                          title={it.showTitle}
                          className="text-sm font-semibold text-white/80 break-words line-clamp-1"
                        >
                          {it.showTitle}
                        </span>
                      )}
                      {ep && (
                        <span className="text-[11px] text-white/55 font-mono shrink-0">
                          {ep}
                        </span>
                      )}
                      <span
                        title={it.message}
                        className="text-[12px] text-white/60 break-words line-clamp-1 hidden sm:inline"
                      >
                        · {it.message}
                      </span>
                      {it.releaseTitle && it.releaseTitle !== it.message && (
                        <span
                          title={it.releaseTitle}
                          className="text-[11px] font-mono text-white/40 break-all line-clamp-1 hidden lg:inline"
                        >
                          {it.releaseTitle}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {it.indexerName && (
                        <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-white/50 border border-white/10 max-w-[120px] truncate">
                          {it.indexerName}
                        </span>
                      )}
                      {it.eventType && it.kind === "event" && (
                        <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-white/40 border border-white/10">
                          {it.eventType.replace(/_/g, " ")}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-white/60 shrink-0 leading-none">
                        {formatImportDate(it.timestamp)}
                      </span>
                    </div>
                  </div>
                );
              })}
              {hasMore && (
                <div className="flex justify-center py-4">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white/60 border border-white/10 hover:text-white hover:bg-white/[0.08] transition-all disabled:opacity-50"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    {loadingMore ? "Loading..." : "Load more"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
