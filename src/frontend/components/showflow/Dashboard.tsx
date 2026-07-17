import {
  CheckIcon, Scan, Activity, ChevronRight, RotateCcw, RefreshCw,
} from "lucide-react";
import * as React from "react";

import { Skeleton } from "@frontend/components/ui/skeleton";
import { EventTicker, type TickerItem } from "@frontend/components/showflow/EventTicker";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { HeaderActions } from "@frontend/lib/header-actions";
import { WatcherPanel, type ActivityEvent } from "@frontend/components/showflow/WatcherPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";

interface UpcomingEpisode {
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string;
  filePath: string | null;
}

function isDateOnly(airDate: string): boolean {
  const d = new Date(airDate);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

function formatAirTime(airDate: string) {
  if (!airDate.includes("T")) return null;
  const d = new Date(airDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

function getLocalDateKey(airDate: string): string {
  const d = new Date(airDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getRelativeDayLabel(airDate: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(airDate);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 0) return `${Math.abs(diffDays)} days ago`;
  return target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function getCompactDate(airDate: string): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(airDate);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  const time = formatAirTime(airDate);
  const timeStr = time ? ` ${time}` : "";

  if (diffDays === 0) return `Today${timeStr}`;
  if (diffDays === -1) return `Yesterday${timeStr}`;
  if (diffDays === 1) return `Tomorrow${timeStr}`;

  const label = target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (time) return `${label}${timeStr}`;
  return label;
}

function isPast(airDate: string): boolean {
  return new Date(airDate).getTime() <= Date.now();
}

function formatNowTime(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

function getRowProximity(airDate: string): { color: string; dot: string } {
  const now = new Date();
  const target = new Date(airDate);
  const diffTime = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { color: "text-white/50", dot: "bg-white/20" };
  if (diffDays <= 1) return { color: "text-signal", dot: "bg-signal" };
  if (diffDays <= 3) return { color: "text-accent-amber", dot: "bg-accent-amber" };
  return { color: "text-white/50", dot: "bg-white/30" };
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-white/5 px-5 py-3">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-32" />
          </div>
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
      <div className="border-b border-white/5 px-5 py-2.5">
        <div className="flex gap-1">
          {Array.from({ length: 11 }, (_, i) => (
            <div key={i} className="flex flex-col items-center gap-1 px-2 py-1.5 min-w-[40px]">
              <Skeleton className="h-2.5 w-6" />
              <Skeleton className="h-3.5 w-4" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 p-5 space-y-4">
        {Array.from({ length: 3 }, (_, g) => (
          <div key={g} className="space-y-1">
            <Skeleton className="h-3 w-20 mb-1.5" />
            {Array.from({ length: g === 0 ? 4 : 2 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                <Skeleton className="size-[18px] rounded-sm shrink-0" />
                <Skeleton className="size-1.5 rounded-full shrink-0" />
                <Skeleton className="h-3.5 flex-1 max-w-[200px]" />
                <Skeleton className="h-3 w-16 shrink-0" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard({
  onSelectShow,
  onShowCalendar,
}: {
  onSelectShow: (show: ShowSummary) => void;
  onShowCalendar: () => void;
}) {
  const [shows, setShows] = React.useState<ShowSummary[] | null>(null);
  const [upcoming, setUpcoming] = React.useState<UpcomingEpisode[] | null>(null);
  const [recentEvents, setRecentEvents] = React.useState<ActivityEvent[]>([]);
  const [processingFiles, setProcessingFiles] = React.useState<string[]>([]);
  const [syncingAll, setSyncingAll] = React.useState(false);
  const [syncProgress, setSyncProgress] = React.useState<{ synced: number; total: number; errors: number } | null>(null);

  const POLL_INTERVAL = 30_000;

  const fetchShowsAndCalendar = React.useCallback(() => {
    fetch("/api/shows")
      .then((r) => r.json())
      .then(setShows)
      .catch(() => setShows([]));

    fetch("/api/calendar?days=7&past=3")
      .then((r) => (r.ok ? r.json() : []))
      .then(setUpcoming)
      .catch(() => setUpcoming([]));
  }, []);

  React.useEffect(() => {
    fetchShowsAndCalendar();
    const id = setInterval(fetchShowsAndCalendar, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchShowsAndCalendar]);

  // Re-fetch when a show finishes syncing, is removed, or is scanned (picked up from WatcherPanel events)
  const lastTriggerEventId = React.useRef(0);
  React.useEffect(() => {
    const triggerEvent = recentEvents.find(
      e => (e.type === 'sync' || e.type === 'delete' || e.type === 'scan') && e.id > lastTriggerEventId.current,
    );
    if (triggerEvent) {
      lastTriggerEventId.current = triggerEvent.id;
      fetchShowsAndCalendar();
    }
  }, [recentEvents, fetchShowsAndCalendar]);

  React.useEffect(() => {
    const poll = () => {
      fetch("/api/system/processing")
        .then((r) => r.json())
        .then((files: string[]) => setProcessingFiles(files))
        .catch(() => setProcessingFiles([]));
    };
    poll();
    const id = setInterval(poll, 5_000);
    return () => clearInterval(id);
  }, []);

  const tickerItems = React.useMemo<TickerItem[]>(() => {
    const eventItems: TickerItem[] = recentEvents.map((e) => {
      let tone: "signal" | "amber" | "muted" = "muted";
      if (e.type === "grab" || e.type === "import") tone = "signal";
      else if (e.type === "error") tone = "amber";
      else if (e.type === "scan" || e.type === "watcher") tone = "signal";
      else if (e.type === "upgrade") tone = "signal";
      
      return {
        key: `event-${e.id}`,
        label: e.message,
        tone,
      };
    });
    const upcomingItems: TickerItem[] = (upcoming ?? []).slice(0, 8).map((ep, i) => {
      const time = formatAirTime(ep.airDate);
      const dateLabel = new Date(ep.airDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return {
        key: `up-${i}`,
        label: `${ep.showTitle} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} airs ${dateLabel}${time ? ` ${time}` : ""}`,
        tone: "amber",
      };
    });
    return [...eventItems, ...upcomingItems];
  }, [recentEvents, upcoming]);

  const groupedEpisodes = React.useMemo(() => {
    if (!upcoming) return [];
    const groups: { [key: string]: UpcomingEpisode[] } = {};
    upcoming.forEach((ep) => {
      const dateKey = getLocalDateKey(ep.airDate);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(ep);
    });
    return Object.entries(groups).map(([dateKey, items]) => {
      const sample = items[0]?.airDate ?? dateKey;
      return {
        dateKey,
        label: getRelativeDayLabel(sample),
        items: [...items].sort((a, b) => new Date(a.airDate).getTime() - new Date(b.airDate).getTime()),
      };
    });
  }, [upcoming]);

  const uniqueShowsCount = React.useMemo(() => {
    if (!upcoming) return 0;
    return new Set(upcoming.map((ep) => ep.showTitle)).size;
  }, [upcoming]);

  const getMatchingShow = (title: string) =>
    shows?.find((s) => s.title.toLowerCase() === title.toLowerCase());

  const calendarDays = React.useMemo(() => {
    const today = new Date();
    return Array.from({ length: 11 }, (_, i) => {
      const date = new Date(today);
      date.setDate(today.getDate() + i - 3);
      return date;
    });
  }, []);

  const episodesByDate = React.useMemo(() => {
    const map = new Map<string, number>();
    if (!upcoming) return map;
    upcoming.forEach((ep) => {
      const dateStr = ep.airDate.slice(0, 10);
      map.set(dateStr, (map.get(dateStr) || 0) + 1);
    });
    return map;
  }, [upcoming]);

  return (
    <div className="h-full flex flex-col gap-6">
      <HeaderActions>
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            onClick={async () => { try { await fetch("/api/system/scan", { method: "POST" }); } catch {} }}
            className="flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/[0.06] transition-all active:scale-[0.98]"
          >
            <Scan className="size-3.5 text-signal" />
            <span>Scan</span>
          </button>
          <button
            onClick={async () => { try { await fetch("/api/system/watch/rescan", { method: "POST" }); } catch {} }}
            className="flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/[0.06] transition-all active:scale-[0.98]"
          >
            <RotateCcw className="size-3.5 text-accent-amber" />
            <span>Rescan</span>
          </button>
          <button
            onClick={async () => {}}
            className="flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/[0.06] transition-all active:scale-[0.98]"
          >
            <RefreshCw className="size-3.5 text-blue-400" />
            <span>Upgrades</span>
          </button>
          <button
            onClick={async () => {
              if (syncingAll) return;
              setSyncingAll(true);
              setSyncProgress({ synced: 0, total: shows?.length || 0, errors: 0 });
              try {
                const res = await fetch("/api/shows/sync-all", { 
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ force: true })
                });
                const data = await res.json();
                if (data.ok) {
                  setSyncProgress({ synced: data.syncedCount, total: data.syncedCount + data.skippedCount, errors: data.errorCount });
                  fetchShowsAndCalendar();
                }
              } catch (err) {
                console.error("Failed to sync all shows:", err);
              } finally {
                setSyncingAll(false);
                setTimeout(() => setSyncProgress(null), 3000);
              }
            }}
            disabled={syncingAll}
            className="flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-white/[0.06] transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Activity className={`size-3.5 text-purple-400 ${syncingAll ? 'animate-spin' : ''}`} />
            <span>{syncingAll ? 'Syncing...' : 'Metadata'}</span>
            {syncProgress && <span className="text-white/60">{syncProgress.synced}/{syncProgress.total}</span>}
          </button>
        </div>
      </HeaderActions>
      {processingFiles.length > 0 && (
        <div className="glass-panel rounded-xl px-5 py-3 flex items-center gap-4 border-signal/15 shrink-0">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-signal" />
          </span>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-white">Now processing</span>
            <span className="text-muted-foreground font-mono text-xs">
              {processingFiles.length} file{processingFiles.length !== 1 && "s"} importing
            </span>
          </div>
          <div className="flex-1" />
          <span className="font-mono text-[9px] text-signal font-bold uppercase tracking-widest">// LIVE</span>
        </div>
      )}

      <div className="flex flex-row gap-6 flex-1 min-h-0 overflow-hidden">

        {/* LEFT COLUMN: Primary Agenda */}
        <GlassPanel className="flex flex-col overflow-hidden flex-1">
          {/* Header */}
          <div className="border-b border-white/5 px-5 py-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">
                  // System Agenda
                </span>
                <h2 className="font-display text-xl font-bold text-white mt-0.5 leading-tight">
                  Upcoming
                </h2>
              </div>
              {upcoming && (
                <div className="text-right font-mono text-xs text-muted-foreground">
                  <span className="text-white font-semibold">{upcoming.length}</span>
                  {" "}episode{upcoming.length !== 1 && "s"}
                  <span className="text-white/20 mx-1.5">|</span>
                  <span className="text-white font-semibold">{uniqueShowsCount}</span>
                  {" "}series
                </div>
              )}
            </div>
          </div>

          {/* Compact Calendar Strip */}
          <div className="border-b border-white/5 px-5 py-2.5 overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {calendarDays.map((date) => {
                const dateStr = date.toISOString().slice(0, 10);
                const count = episodesByDate.get(dateStr) || 0;
                const isToday = dateStr === new Date().toISOString().slice(0, 10);
                return (
                  <div
                    key={dateStr}
                    className={cn(
                      "flex flex-col items-center rounded-md px-2 py-1.5 min-w-[40px] transition-all duration-150",
                      count > 0
                        ? "bg-signal/8 border border-signal/12"
                        : "bg-transparent border border-transparent",
                      isToday && "ring-1 ring-signal/30",
                    )}
                  >
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span
                      className={cn(
                        "font-display text-xs font-bold leading-tight",
                        count > 0 ? "text-white" : "text-white/40",
                        isToday && "text-signal",
                      )}
                    >
                      {date.getDate()}
                    </span>
                    {count > 0 && (
                      <span className="text-[8px] font-bold text-signal">{count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dense Episode List */}
          <div className="flex-1 overflow-y-auto p-5">
            {upcoming === null ? (
              <DashboardSkeleton />
            ) : upcoming.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground text-xs font-mono">
                NO EPISODES IN THE LAST 3 DAYS OR NEXT 7 DAYS.
              </div>
            ) : (
              <div className="space-y-4">
                {groupedEpisodes.map((group, gi) => (
                  <div
                    key={group.dateKey}
                    className="space-y-0.5 animate-fade-in"
                    style={{ animationDelay: `${gi * 60}ms` }}
                  >
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/30 border-b border-white/5 pb-1 mb-1">
                      {group.label}
                    </h3>
                    {(() => {
                      const isToday = group.label === "Today";
                      const nowLineIdx = isToday ? group.items.findIndex((ep) => !isPast(ep.airDate)) : -1;
                      const hasNowLine = nowLineIdx > 0;
                      return group.items.map((ep, i) => {
                      const showObj = getMatchingShow(ep.showTitle);
                      const prox = getRowProximity(ep.airDate);
                      const time = formatAirTime(ep.airDate);
                      return (
                        <React.Fragment key={`${ep.showTitle}-${ep.season}-${ep.episode}-${i}`}>
                          {hasNowLine && i === nowLineIdx && (
                            <div className="relative flex items-center py-1">
                              <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-signal/40" />
                              </div>
                              <div className="relative flex items-center gap-2">
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-signal/10 px-2.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-signal border border-signal/20">
                                  NOW — {formatNowTime()}
                                </span>
                              </div>
                            </div>
                          )}
                        <div
                          onClick={() => {
                            if (showObj) onSelectShow(showObj);
                          }}
                          className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 cursor-pointer transition-all duration-150 hover:bg-white/[0.03]"
                          style={{ animationDelay: `${gi * 60 + i * 30}ms` }}
                        >
                          {showObj ? (
                            <PosterImage
                              showId={showObj.id}
                              alt={ep.showTitle}
                              className="w-[18px] h-[27px] shrink-0 rounded-sm bg-white/5 object-cover"
                            />
                          ) : (
                            <div className="w-[18px] h-[27px] shrink-0 rounded-sm bg-white/[0.03] border border-white/5 flex items-center justify-center">
                              <span className="font-mono text-[5px] text-white/20">N/A</span>
                            </div>
                          )}
                          <span className={cn("size-1.5 shrink-0 rounded-full", prox.dot)} />
                          <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                            <span className={cn(
                              "text-sm font-semibold truncate transition-colors",
                              prox.color,
                              "group-hover:text-white",
                            )}>
                              {ep.showTitle}
                            </span>
                            <span className="text-[11px] text-white/30 font-mono shrink-0">
                              S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                            </span>
                            {ep.episodeTitle && (
                              <span className="text-[12px] text-white/40 truncate hidden sm:inline">
                                · {ep.episodeTitle}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {ep.filePath && (
                              <span className="flex items-center gap-1 rounded-full bg-signal/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-signal border border-signal/15">
                                <CheckIcon className="size-2.5" strokeWidth={3} />
                                Available
                              </span>
                            )}
                            <span className="text-[11px] font-mono text-white/40 shrink-0 leading-none">
                              {getCompactDate(ep.airDate)}
                            </span>
                          </div>
                        </div>
                      </React.Fragment>
                      );
                    });
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Calendar View Footer */}
          {upcoming && upcoming.length > 0 && (
            <div className="border-t border-white/5 px-5 py-2.5">
              <button
                onClick={onShowCalendar}
                className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground hover:text-white uppercase tracking-wider transition-colors"
              >
                + Calendar view
                <ChevronRight className="size-3" />
              </button>
            </div>
          )}
        </GlassPanel>

        {/* RIGHT COLUMN: Live Events */}
        <div className="flex flex-col gap-4 w-[340px] min-w-[340px] shrink-0 min-h-0">
          <WatcherPanel onEvents={setRecentEvents} className="flex-1 min-h-0" />
        </div>
      </div>
    </div>
  );
}

export { Dashboard };
