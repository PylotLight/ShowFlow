import { Check, Loader2, Trash2 } from "lucide-react";
import * as React from "react";

import type { LibraryFilter } from "@frontend/components/showflow/FilterRail";
import { PosterCard, type ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

const POSTER_SIZE_KEY = 'showflow-poster-size';
const MIN_POSTER_SIZE = 180;
const MAX_POSTER_SIZE = 300;
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

  const [backdropShow, setBackdropShow] = React.useState<ShowSummary | null>(null);
  const rotRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = React.useRef<ShowSummary[]>([]);
  const idxRef = React.useRef(0);

  React.useEffect(() => {
    fetch("/api/shows")
      .then((r) => r.json())
      .then(setShows);
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
    if (filter.providerType) result = result.filter((s) => s.providerType === filter.providerType);
    if (filter.profile) result = result.filter((s) => s.profile === filter.profile);
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter((s) => s.title.toLowerCase().includes(q));
    }
    return result;
  }, [shows, query, filter]);

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

                {/* Poster size slider (push to right) */}
                <div className="ml-auto flex items-center gap-2 text-muted-foreground">
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
                    step={5}
                    value={posterSize}
                    onChange={handlePosterSize}
                    className="w-20 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-signal
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-signal [&::-webkit-slider-thumb]:shadow-sm"
                  />
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
    </>
  );
}
