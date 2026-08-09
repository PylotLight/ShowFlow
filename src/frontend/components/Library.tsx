import { Check, Loader2, Trash2, ArrowUpDown, Eye, EyeOff, ListFilter, Settings2 } from "lucide-react";
import * as React from "react";

import type { LibraryFilter } from "@frontend/components/showflow/FilterRail";
import { PosterCard, type ShowSummary } from "@frontend/components/showflow/PosterCard";
import { BulkUpdateDialog } from "@frontend/components/showflow/BulkUpdateDialog";
import { cn } from "@frontend/lib/utils";

const POSTER_SIZE_KEY = 'showflow-poster-size';
const MIN_POSTER_SIZE = 120;
const MAX_POSTER_SIZE = 400;
const DEFAULT_POSTER_SIZE = 300;
const ROTATION_INTERVAL = 12000;
const HOVER_RESUME_DELAY = 4000;

function loadPosterSize(): number {
  try {
    const saved = localStorage.getItem(POSTER_SIZE_KEY);
    if (saved) {
      const val = parseInt(saved, 10);
      if (!isNaN(val) && val >= MIN_POSTER_SIZE && val <= MAX_POSTER_SIZE) return val;
    }
  } catch {}
  return DEFAULT_POSTER_SIZE;
}

function savePosterSize(size: number) {
  try { localStorage.setItem(POSTER_SIZE_KEY, size.toString()); } catch {}
}

export function Library({
  query,
  onSelectShow,
  onBackdropChange,
}: {
  query: string;
  onSelectShow: (show: ShowSummary) => void;
  onBackdropChange?: (url: string) => void;
}) {
  const [shows, setShows] = React.useState<ShowSummary[] | null>(null);
  const [filter, setFilter] = React.useState<LibraryFilter>({ providerType: null, profile: null });
  const [posterSize, setPosterSize] = React.useState(loadPosterSize);

  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [removing, setRemoving] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);

  const [sortBy, setSortBy] = React.useState<'title' | 'added' | 'updated' | 'tracked' | 'grabbed'>('title');
  const [sortOrder, setSortOrder] = React.useState<'asc' | 'desc'>('asc');
  const [seriesTypeFilter, setSeriesTypeFilter] = React.useState<string | null>(null);
  const [trackingFilter, setTrackingFilter] = React.useState<'all' | 'tracked' | 'untracked'>('all');
  const [showProvider, setShowProvider] = React.useState(true);
  const [showStats, setShowStats] = React.useState(true);

  const [backdropShow, setBackdropShow] = React.useState<ShowSummary | null>(null);
  const rotRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = React.useRef<ShowSummary[]>([]);
  const idxRef = React.useRef(0);

  async function loadShows() {
    try {
      const res = await fetch("/api/shows");
      if (!res.ok) return;
      setShows(await res.json());
    } catch {}
  }

  React.useEffect(() => {
    loadShows();
  }, []);

  React.useEffect(() => {
    if (!shows || shows.length === 0) return;
    const q = [...shows].sort(() => Math.random() - 0.5);
    queueRef.current = q;
    idxRef.current = 0;
    setBackdropShow(q[0] ?? null);

    rotRef.current = setInterval(() => {
      if (hoverTimerRef.current) return;
      idxRef.current = (idxRef.current + 1) % q.length;
      setBackdropShow(q[idxRef.current] ?? null);
    }, ROTATION_INTERVAL);

    return () => {
      if (rotRef.current) clearInterval(rotRef.current);
    };
  }, [shows]);

  React.useEffect(() => {
    if (!backdropShow || !onBackdropChange) return;
    onBackdropChange(`/api/shows/${backdropShow.id}/images/backdrop`);
  }, [backdropShow, onBackdropChange]);

  function handleShowHover(show: ShowSummary) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
    }, HOVER_RESUME_DELAY);
    setBackdropShow(show);
  }

  const filtered = React.useMemo(() => {
    if (!shows) return null;
    let result = shows;
    
    // Apply filters
    if (filter.providerType) result = result.filter((s) => s.providerType === filter.providerType);
    if (filter.profile) result = result.filter((s) => s.profile === filter.profile);
    if (seriesTypeFilter) result = result.filter((s) => s.seriesType === seriesTypeFilter);
    
    if (trackingFilter === 'tracked') {
      result = result.filter((s) => (s.trackedCount || 0) > 0);
    } else if (trackingFilter === 'untracked') {
      result = result.filter((s) => (s.trackedCount || 0) === 0);
    }
    
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter((s) => s.title.toLowerCase().includes(q));
    }
    
    // Apply sorting
    result = [...result].sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'added':
          comparison = (a.addedAt || '').localeCompare(b.addedAt || '');
          break;
        case 'updated':
          comparison = (a.lastUpdated || '').localeCompare(b.lastUpdated || '');
          break;
        case 'tracked':
          comparison = (a.trackedCount || 0) - (b.trackedCount || 0);
          break;
        case 'grabbed':
          comparison = (a.grabbedCount || 0) - (b.grabbedCount || 0);
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [shows, query, filter, seriesTypeFilter, trackingFilter, sortBy, sortOrder]);

  function handlePosterSize(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseInt(e.target.value, 10);
    setPosterSize(val);
    savePosterSize(val);
  }

  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSelectAll() {
    if (!filtered) return;
    const allSelected = filtered.length > 0 && filtered.every(s => selectedIds.has(s.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(s => s.id)));
    }
  }

  async function handleBulkRemove() {
    const count = selectedIds.size;
    if (count === 0) return;
    const names = shows?.filter((s) => selectedIds.has(s.id)).map((s) => s.title) ?? [];
    const msg = `Remove ${count} show${count !== 1 ? "s" : ""}?\n\n${names.join("\n")}`;
    if (!confirm(msg)) return;
    setRemoving(true);
    try {
      const res = await fetch("/api/shows/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) throw new Error("Failed to remove shows");
      setShows((prev) => (prev ? prev.filter((s) => !selectedIds.has(s.id)) : prev));
      setSelectedIds(new Set());
    } catch (err) {
      alert(`Error removing shows: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="flex-1 flex flex-col min-w-0">
          {filtered === null ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading library...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-24 text-center">
              <p className="text-lg">{shows && shows.length > 0 ? "No matches." : "Nothing tracked yet."}</p>
              <p className="text-sm">
                {shows && shows.length > 0
                  ? "Try a different search or filter."
                  : "Add a show to get it appearing here."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center flex-wrap gap-x-6 gap-y-3 mb-5 shrink-0">
                {/* Provider filter */}
                {shows && (() => {
                  const pts = Array.from(new Set(shows.map(s => s.providerType))).sort();
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-caption uppercase tracking-wider text-white/40 mr-1">Provider</span>
                      <button onClick={() => setFilter(f => ({ ...f, providerType: null }))}
                        className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${filter.providerType === null ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>All</button>
                      {pts.map(pt => (
                        <button key={pt} onClick={() => setFilter(f => ({ ...f, providerType: pt }))}
                          className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${filter.providerType === pt ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>{pt}</button>
                      ))}
                    </div>
                  );
                })()}

                {/* Profile filter */}
                {shows && (() => {
                  const profiles = Array.from(new Set(shows.map(s => s.profile).filter((p): p is string => !!p))).sort();
                  if (profiles.length === 0) return null;
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-caption uppercase tracking-wider text-white/40 mr-1">Profile</span>
                      <button onClick={() => setFilter(f => ({ ...f, profile: null }))}
                        className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${filter.profile === null ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>All</button>
                      {profiles.map(p => (
                        <button key={p} onClick={() => setFilter(f => ({ ...f, profile: p }))}
                          className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${filter.profile === p ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>{p}</button>
                      ))}
                    </div>
                  );
                })()}

                {/* Series type filter */}
                {shows && (() => {
                  const seriesTypes = Array.from(new Set(shows.map(s => s.seriesType).filter((t): t is string => !!t))).sort();
                  if (seriesTypes.length === 0) return null;
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-caption uppercase tracking-wider text-white/40 mr-1">Type</span>
                      <button onClick={() => setSeriesTypeFilter(null)}
                        className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${seriesTypeFilter === null ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>All</button>
                      {seriesTypes.map(st => (
                        <button key={st} onClick={() => setSeriesTypeFilter(st)}
                          className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${seriesTypeFilter === st ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>{st}</button>
                      ))}
                    </div>
                  );
                })()}

                {/* Tracking filter */}
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-caption uppercase tracking-wider text-white/40 mr-1">Tracking</span>
                  <button onClick={() => setTrackingFilter('all')}
                    className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${trackingFilter === 'all' ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>All</button>
                  <button onClick={() => setTrackingFilter('tracked')}
                    className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${trackingFilter === 'tracked' ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>Tracked</button>
                  <button onClick={() => setTrackingFilter('untracked')}
                    className={`rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${trackingFilter === 'untracked' ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}>Untracked</button>
                </div>

                {/* Sort dropdown */}
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-caption uppercase tracking-wider text-white/40 mr-1">Sort</span>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80 border-0 cursor-pointer"
                  >
                    <option value="title">Title</option>
                    <option value="added">Added</option>
                    <option value="updated">Updated</option>
                    <option value="tracked">Tracked</option>
                    <option value="grabbed">Grabbed</option>
                  </select>
                  <button
                    onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                    className="rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80"
                  >
                    <ArrowUpDown className="size-3" />
                  </button>
                </div>

                {/* Controls section (push to right) */}
                <div className="ml-auto flex items-center gap-4 text-muted-foreground">
                  {/* Show/hide toggles */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowProvider(prev => !prev)}
                      className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${showProvider ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}
                    >
                      {showProvider ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                      Provider
                    </button>
                    <button
                      onClick={() => setShowStats(prev => !prev)}
                      className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors ${showStats ? 'bg-signal text-signal-foreground' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'}`}
                    >
                      {showStats ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                      Stats
                    </button>
                  </div>

                  {/* Select all */}
                  <button
                    onClick={handleSelectAll}
                    className="flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-sub font-medium tracking-wide transition-colors bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80"
                  >
                    <Check className="size-3" />
                    {filtered && filtered.length > 0 && filtered.every(s => selectedIds.has(s.id)) ? 'Deselect All' : 'Select All'}
                  </button>

                  {/* Poster size slider */}
                  <div className="flex items-center gap-2">
                    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1" />
                      <rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" />
                      <rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                    <input
                      type="range"
                      min={MIN_POSTER_SIZE}
                      max={MAX_POSTER_SIZE}
                      step={10}
                      value={posterSize}
                      onChange={handlePosterSize}
                      className="w-24 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-signal
                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-signal [&::-webkit-slider-thumb]:shadow-sm"
                    />
                  </div>
                </div>
              </div>

              <div
                className="grid gap-5"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${posterSize}px, 1fr))` }}
              >
                {filtered.map((show) => (
                  <div key={show.id} className="relative group" onMouseEnter={() => handleShowHover(show)}>
                    <div
                      className="absolute top-2 left-2 z-10 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); toggleSelection(show.id); }}
                    >
                      <div
                        className={cn(
                          "size-5 rounded-full border-2 flex items-center justify-center transition-all duration-150",
                          selectedIds.has(show.id)
                            ? "bg-signal border-signal shadow-[0_0_8px_var(--signal)]"
                            : "border-white/30 bg-black/30 group-hover:border-white/60"
                        )}
                      >
                        {selectedIds.has(show.id) && <Check className="size-3 text-white" strokeWidth={3} />}
                      </div>
                    </div>
                    <PosterCard
                      show={show}
                      onClick={() => onSelectShow(show)}
                      selected={selectedIds.has(show.id)}
                      showProvider={showProvider}
                      showStats={showStats}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      {/* Floating action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 md:bottom-6 animate-[slideUp_0.2s_ease-out]">
          <div className="glass-panel rounded-full px-5 py-2.5 flex items-center gap-4 shadow-2xl">
            <span className="font-mono text-xs text-white/70 whitespace-nowrap">
              {selectedIds.size} selected
            </span>
            <div className="w-px h-5 bg-white/10" />
            <button
              onClick={() => setBulkOpen(true)}
              className="flex items-center gap-2 rounded-full bg-signal/15 text-signal hover:bg-signal/25 px-4 py-1.5 text-sm font-medium transition-colors"
            >
              <Settings2 className="size-3.5" />
              Configure
            </button>
            <button
              onClick={handleBulkRemove}
              disabled={removing}
              className="flex items-center gap-2 rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50 px-4 py-1.5 text-sm font-medium transition-colors"
            >
              {removing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-muted-foreground hover:text-white transition-colors font-mono uppercase tracking-wider"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <BulkUpdateDialog
        ids={Array.from(selectedIds)}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onDone={() => {
          loadShows();
          setSelectedIds(new Set());
        }}
      />
    </>
  );
}
