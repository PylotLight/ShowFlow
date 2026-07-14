import {
  CheckIcon, ChevronLeft, ChevronRight, Loader2,
} from "lucide-react";
import * as React from "react";

import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

interface UpcomingEpisode {
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string;
  showId: string;
  filePath: string | null;
}

function key(ep: UpcomingEpisode) {
  return `${ep.showTitle}-${ep.season}-${ep.episode}-${ep.airDate}`;
}

function CalendarView({ onSelectShow }: { onSelectShow: (show: ShowSummary) => void }) {
  const [shows, setShows] = React.useState<ShowSummary[]>([]);
  const [allEpisodes, setAllEpisodes] = React.useState<Map<string, UpcomingEpisode>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [cursor, setCursor] = React.useState(new Date());
  const [expandedDay, setExpandedDay] = React.useState<string | null>(null);
  const [loadedRange, setLoadedRange] = React.useState<{ past: number; future: number }>({ past: 0, future: 0 });
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;

  const POLL_INTERVAL = 30_000;

  const fetchShows = React.useCallback(() => {
    fetch("/api/shows")
      .then((r) => r.json())
      .then(setShows)
      .catch(() => setShows([]));
  }, []);

  const fetchCalendar = React.useCallback(() => {
    if (loadedRange.past === 0 && loadedRange.future === 0) return;
    fetch(`/api/calendar?past=${loadedRange.past}&days=${loadedRange.future}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: UpcomingEpisode[]) => {
        setAllEpisodes(existing => {
          const next = new Map(existing);
          for (const ep of data) next.set(key(ep), ep);
          return next;
        });
      })
      .catch(() => {});
  }, [loadedRange.past, loadedRange.future]);

  // Fetch shows with polling
  React.useEffect(() => {
    fetchShows();
    const id = setInterval(fetchShows, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchShows]);

  // Periodically re-fetch calendar episodes
  React.useEffect(() => {
    if (loadedRange.past === 0 && loadedRange.future === 0) return;
    fetchCalendar();
    const id = setInterval(fetchCalendar, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchCalendar, loadedRange.past, loadedRange.future]);

  // Poll for events to trigger immediate re-fetch on sync or delete
  const lastTriggerEventId = React.useRef(0);
  const fetchShowsAndCalendar = React.useCallback(() => {
    fetchShows();
    fetchCalendar();
  }, [fetchShows, fetchCalendar]);

  React.useEffect(() => {
    const pollEvents = () => {
      fetch("/api/events?limit=10")
        .then((r) => r.json())
        .then((events: { id: number; type: string }[]) => {
          const triggerEvent = events.find(
            e => (e.type === 'sync' || e.type === 'delete' || e.type === 'scan') && e.id > lastTriggerEventId.current,
          );
          if (triggerEvent) {
            lastTriggerEventId.current = triggerEvent.id;
            fetchShowsAndCalendar();
          }
        })
        .catch(() => {});
    };
    pollEvents();
    const id = setInterval(pollEvents, 15_000);
    return () => clearInterval(id);
  }, [fetchShowsAndCalendar]);

  // Fetch episodes with expanding range
  const ensureRange = React.useCallback((needPast: number, needFuture: number) => {
    setLoadedRange(prev => {
      const newPast = Math.max(prev.past, needPast);
      const newFuture = Math.max(prev.future, needFuture);
      if (newPast > prev.past || newFuture > prev.future) {
        fetch(`/api/calendar?past=${newPast}&days=${newFuture}`)
          .then((r) => (r.ok ? r.json() : []))
          .then((data: UpcomingEpisode[]) => {
            setAllEpisodes(existing => {
              const next = new Map(existing);
              for (const ep of data) next.set(key(ep), ep);
              return next;
            });
          })
          .catch(() => {})
          .finally(() => setLoading(false));
        return { past: newPast, future: newFuture };
      }
      return prev;
    });
  }, []);

  // Initial fetch — 2 years each direction
  React.useEffect(() => {
    ensureRange(730, 730);
  }, [ensureRange]);

  // When cursor moves, ensure we have that range covered
  React.useEffect(() => {
    const now = Date.now();
    const monthStart = new Date(year, month, 1).getTime();
    const monthEnd = new Date(year, month + 1, 0).getTime();
    const pastNeeded = Math.ceil((now - monthStart) / (1000 * 60 * 60 * 24)) + 60;
    const futureNeeded = Math.ceil((monthEnd - now) / (1000 * 60 * 60 * 24)) + 60;
    ensureRange(Math.max(pastNeeded, 30), Math.max(futureNeeded, 30));
  }, [year, month, ensureRange]);

  const episodes = React.useMemo(() => [...allEpisodes.values()], [allEpisodes]);

  const grid = React.useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const padded: (number | null)[] = Array(startDow).fill(null);
    for (let d = 1; d <= daysInMonth; d++) padded.push(d);
    while (padded.length % 7 !== 0) padded.push(null);

    const rows: (number | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
      rows.push(padded.slice(i, i + 7));
    }
    return rows;
  }, [year, month]);

  const monthEpisodes = React.useMemo(() => {
    const map = new Map<string, UpcomingEpisode[]>();
    for (const ep of episodes) {
      if (ep.airDate.startsWith(monthKey)) {
        const key_ = ep.airDate.slice(0, 10);
        if (!map.has(key_)) map.set(key_, []);
        map.get(key_)!.push(ep);
      }
    }
    return map;
  }, [episodes, monthKey]);

  const todayStr = new Date().toISOString().slice(0, 10);

  function getMatchingShow(showId: string) {
    return shows.find((s) => s.id === showId);
  }

  function goMonth(delta: number) {
    setCursor(new Date(year, month + delta, 1));
    setExpandedDay(null);
  }

  function handleMouseEnter(dateStr: string) {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setExpandedDay(dateStr);
    }, 700);
  }

  function handleMouseLeave() {
    clearTimeout(hoverTimerRef.current);
    setExpandedDay(null);
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (loading && episodes.length === 0) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalEpisodes = [...monthEpisodes.values()].reduce((sum, eps) => sum + eps.length, 0);
  const totalSeries = new Set([...monthEpisodes.values()].flat().map(e => e.showTitle)).size;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 px-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => goMonth(-1)}
            className="rounded-lg p-1.5 text-muted-foreground hover:text-white hover:bg-white/5 transition-all"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={() => setCursor(new Date())}
            className="rounded-lg px-3 py-1 hover:bg-white/5 transition-all"
          >
            <h2 className="font-display text-xl font-bold text-white min-w-[160px]">
              {cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </h2>
          </button>
          <button
            onClick={() => goMonth(1)}
            className="rounded-lg p-1.5 text-muted-foreground hover:text-white hover:bg-white/5 transition-all"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-[11px] text-muted-foreground">
            <span className="text-white font-semibold">{totalEpisodes}</span> ep
            <span className="text-white/20 mx-1.5">|</span>
            <span className="text-white font-semibold">{totalSeries}</span> series
          </span>
          <button
            onClick={() => setCursor(new Date())}
            className="rounded-full px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider bg-signal/15 text-signal border border-signal/10 hover:bg-signal/20 transition-all"
          >
            Today
          </button>
        </div>
      </div>

      {/* Full-Page Calendar Grid */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1 mb-1 shrink-0">
          {dayNames.map((d) => (
            <div key={d} className="font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground text-center py-1">
              {d}
            </div>
          ))}
        </div>

        {/* Grid rows */}
        <div className="flex-1 grid grid-rows-5 gap-1 min-h-0">
          {grid.map((row, ri) => (
            <div key={ri} className="grid grid-cols-7 gap-1 min-h-0">
              {row.map((day, ci) => {
                if (day === null) return <div key={`e-${ci}`} />;

                const dateStr = `${monthKey}-${String(day).padStart(2, "0")}`;
                const dayEps = monthEpisodes.get(dateStr);
                const count = dayEps?.length ?? 0;
                const isToday = dateStr === todayStr;
                const isExpanded = dateStr === expandedDay;
                const isPast = dateStr < todayStr;

                return (
                  <div
                    key={dateStr}
                    onMouseEnter={() => handleMouseEnter(dateStr)}
                    onMouseLeave={handleMouseLeave}
                    className={cn(
                      "relative flex flex-col rounded-lg border transition-all duration-150 overflow-hidden min-h-0",
                      isToday && "border-signal/40 bg-signal/[0.04]",
                      isExpanded && "border-signal/60 bg-signal/[0.08] z-10",
                      !isToday && !isExpanded && count > 0 && "border-white/10 bg-white/[0.02] hover:border-white/15",
                      !isToday && !isExpanded && count === 0 && "border-white/5 bg-white/[0.005]",
                    )}
                  >
                    {/* Day number */}
                    <div className="flex items-center justify-between px-2 pt-1.5 pb-0.5 shrink-0">
                      <span
                        className={cn(
                          "font-mono text-sm font-bold leading-none",
                          isToday ? "text-signal" : isPast ? "text-white/35" : "text-white/75",
                        )}
                      >
                        {day}
                      </span>
                      {count > 0 && (
                        <span className="font-mono text-[10px] text-signal font-semibold bg-signal/10 px-1.5 py-0.5 rounded leading-none">
                          {count}
                        </span>
                      )}
                    </div>

                    {/* Episode list */}
                    {count > 0 && (
                      <div className="flex-1 px-1.5 pb-1.5 space-y-0.5 overflow-hidden min-h-0">
                        {dayEps!.slice(0, 6).map((ep, i) => (
                          <button
                            key={i}
                            onClick={(e) => {
                              e.stopPropagation();
                              const showObj = getMatchingShow(ep.showId);
                              if (showObj) onSelectShow(showObj);
                            }}
                            className="group/ep w-full text-left rounded px-1 py-0.5 hover:bg-white/[0.06] transition-colors block overflow-hidden"
                          >
                            <div className="flex items-center gap-1 overflow-hidden">
                              <span className="font-mono text-[11px] text-white/90 leading-tight whitespace-nowrap overflow-hidden min-w-0">
                                <span className="group-hover/ep:animate-[ticker_8s_linear_infinite] inline-block pr-8">
                                  {ep.showTitle}
                                </span>
                              </span>
                              <span className="font-mono text-[9px] text-signal/80 shrink-0">
                                S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                              </span>
                            </div>
                          </button>
                        ))}
                        {count > 6 && (
                          <span className="font-mono text-[10px] text-signal font-semibold px-1 leading-none block mt-0.5">
                            +{count - 6} more
                          </span>
                        )}
                      </div>
                    )}

                    {/* Expanded popover */}
                    {isExpanded && count > 0 && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 w-72 z-20 pointer-events-auto"
                        onMouseEnter={() => {
                          clearTimeout(hoverTimerRef.current);
                          setExpandedDay(dateStr);
                        }}
                        onMouseLeave={handleMouseLeave}
                      >
                        <div className="glass-panel rounded-xl p-3 space-y-2 shadow-2xl border border-white/10">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-signal border-b border-white/5 pb-1.5">
                            {new Date(dateStr).toLocaleDateString(undefined, {
                              weekday: "long", month: "short", day: "numeric",
                            })}
                            <span className="text-muted-foreground ml-2 font-normal normal-case">
                              {count} episode{count !== 1 && "s"}
                            </span>
                          </div>
                          <div className="space-y-1 max-h-64 overflow-y-auto">
                            {dayEps!.map((ep, i) => {
                              const showObj = getMatchingShow(ep.showId);
                              const available = !!ep.filePath;
                              return (
                                <button
                                  key={i}
                                  onClick={() => {
                                    if (showObj) onSelectShow(showObj);
                                  }}
                                  className="w-full flex items-center gap-2.5 rounded-lg p-2 hover:bg-white/[0.04] transition-colors text-left"
                                >
                                  {showObj ? (
                                    <PosterImage
                                      showId={showObj.id}
                                      alt={ep.showTitle}
                                      className="w-7 h-10 shrink-0 rounded bg-white/5 object-cover"
                                    />
                                  ) : (
                                    <div className="w-7 h-10 shrink-0 rounded bg-white/[0.03] border border-white/5 flex items-center justify-center">
                                      <span className="font-mono text-[6px] text-white/20">N/A</span>
                                    </div>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-semibold text-white truncate">
                                        {ep.showTitle}
                                      </span>
                                      <EpisodeChip season={ep.season} episode={ep.episode} state={available ? "tracked" : "airing"} className="shrink-0 text-[9px]" />
                                    </div>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      {ep.episodeTitle && (
                                        <span className="text-[10px] text-muted-foreground truncate">
                                          {ep.episodeTitle}
                                        </span>
                                      )}
                                      {available && (
                                        <span className="inline-flex items-center gap-0.5 rounded-full bg-signal/10 px-1.5 py-0.5 font-mono text-[7px] font-bold uppercase tracking-wider text-signal border border-signal/15">
                                          <CheckIcon className="size-2" strokeWidth={3} />
                                          Grabbed
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { CalendarView };
export type { UpcomingEpisode };
