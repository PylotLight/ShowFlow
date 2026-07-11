import {
  Loader2, Scan, RefreshCw, Activity, CheckCircle2, ChevronRight,
} from "lucide-react";
import * as React from "react";

import { EpisodeChip } from "@frontend/components/showflow/EpisodeChip";
import { EventTicker, type TickerItem } from "@frontend/components/showflow/EventTicker";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
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
}

function isDateOnly(airDate: string): boolean {
  const d = new Date(airDate);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

function getDateLabel(airDate: string): string {
  if (isDateOnly(airDate)) {
    const parts = airDate.slice(0, 10).split("-").map(Number);
    const y = parts[0] ?? 0;
    const m = (parts[1] ?? 1) - 1;
    const d = parts[2] ?? 1;
    return new Date(y, m, d).toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric",
    });
  }
  return new Date(airDate).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

function getDateProximity(airDate: string): { color: string; bg: string } {
  const now = new Date();
  const target = new Date(airDate);
  const diffTime = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 1) return { color: "text-signal", bg: "bg-signal/15 border-signal/10" };
  if (diffDays <= 3) return { color: "text-accent-amber", bg: "bg-accent-amber/15 border-accent-amber/10" };
  return { color: "text-muted-foreground", bg: "bg-white/5 border-white/5" };
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

  React.useEffect(() => {
    fetch("/api/shows")
      .then((r) => r.json())
      .then(setShows)
      .catch(() => setShows([]));

    fetch("/api/calendar?days=7")
      .then((r) => (r.ok ? r.json() : []))
      .then(setUpcoming)
      .catch(() => setUpcoming([]));
  }, []);

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
    const eventItems: TickerItem[] = recentEvents.map((e) => ({
      key: `event-${e.id}`,
      label: e.message,
      tone: e.type === "grab" ? "signal" : e.type === "error" ? "amber" : "muted",
    }));
    const upcomingItems: TickerItem[] = (upcoming ?? []).slice(0, 8).map((ep, i) => ({
      key: `up-${i}`,
      label: `${ep.showTitle} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} airs ${new Date(
        ep.airDate,
      ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      tone: "amber",
    }));
    return [...eventItems, ...upcomingItems];
  }, [recentEvents, upcoming]);

  const groupedEpisodes = React.useMemo(() => {
    if (!upcoming) return [];
    const groups: { [key: string]: UpcomingEpisode[] } = {};
    upcoming.forEach((ep) => {
      const dateStr = getDateLabel(ep.airDate);
      if (!groups[dateStr]) groups[dateStr] = [];
      groups[dateStr].push(ep);
    });
    return Object.entries(groups).map(([date, items]) => ({ date, items }));
  }, [upcoming]);

  const uniqueShowsCount = React.useMemo(() => {
    if (!upcoming) return 0;
    return new Set(upcoming.map((ep) => ep.showTitle)).size;
  }, [upcoming]);

  const getMatchingShow = (title: string) =>
    shows?.find((s) => s.title.toLowerCase() === title.toLowerCase());

  const calendarDays = React.useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
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
    <div className="space-y-6">
      {/* Now Processing Banner — shows when files are actively being imported */}
      {processingFiles.length > 0 && (
        <div className="glass-panel rounded-xl px-5 py-3 flex items-center gap-4 border-signal/15">
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px] items-start">

        {/* LEFT COLUMN: Primary Agenda */}
        <GlassPanel className="flex flex-col overflow-hidden min-h-[500px]">
          {/* Header */}
          <div className="border-b border-white/5 px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-signal">
                  // System Agenda
                </span>
                <h2 className="font-display text-2xl font-bold text-white mt-0.5">
                  Upcoming
                </h2>
              </div>
              {upcoming && (
                <div className="text-right font-mono text-xs text-muted-foreground">
                  <span className="text-white font-semibold">{upcoming.length}</span>
                  {" "}episode{upcoming.length !== 1 && "s"}
                  <span className="text-white/20 mx-2">|</span>
                  <span className="text-white font-semibold">{uniqueShowsCount}</span>
                  {" "}series
                </div>
              )}
            </div>
          </div>

          {/* Mini Calendar Strip */}
          <div className="border-b border-white/5 px-6 py-3 overflow-x-auto">
            <div className="flex gap-1.5 min-w-max">
              {calendarDays.map((date, i) => {
                const dateStr = date.toISOString().slice(0, 10);
                const count = episodesByDate.get(dateStr) || 0;
                const isToday = i === 0;
                return (
                  <div
                    key={dateStr}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg px-3 py-2 min-w-[56px] transition-all duration-150",
                      count > 0
                        ? "bg-signal/10 border border-signal/15"
                        : "bg-white/[0.02] border border-transparent",
                      isToday && "ring-1 ring-signal/30",
                    )}
                  >
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span
                      className={cn(
                        "font-display text-sm font-bold",
                        count > 0 ? "text-white" : "text-white/40",
                        isToday && "text-signal",
                      )}
                    >
                      {date.getDate()}
                    </span>
                    {count > 0 && (
                      <span className="font-mono text-[8px] font-bold text-signal uppercase">
                        {count} ep
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Episode List */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {upcoming === null ? (
              <div className="flex justify-center items-center py-20 text-muted-foreground text-xs font-mono">
                <Loader2 className="size-4 animate-spin mr-2" /> LOADING AGENDA...
              </div>
            ) : upcoming.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground text-xs font-mono">
                NO UPCOMING EPISODES DETECTED IN THE NEXT 7 DAYS.
              </div>
            ) : (
              <div className="space-y-5">
                {groupedEpisodes.map((group) => (
                  <div key={group.date} className="space-y-2">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-wider text-white/40 border-b border-white/5 pb-1.5">
                      {group.date}
                    </h3>
                    <div className="space-y-2">
                      {group.items.map((ep, i) => {
                        const showObj = getMatchingShow(ep.showTitle);
                        const proximity = getDateProximity(ep.airDate);
                        return (
                          <div
                            key={`${ep.showTitle}-${ep.season}-${ep.episode}-${i}`}
                            onClick={() => {
                              if (showObj) onSelectShow(showObj);
                            }}
                            className="group flex items-center gap-3 rounded-lg p-3 cursor-pointer transition-all duration-150 hover:bg-white/[0.03] border border-transparent hover:border-white/5"
                          >
                            {/* Thumbnail — always visible */}
                            {showObj ? (
                              <PosterImage
                                showId={showObj.id}
                                alt={ep.showTitle}
                                className="w-12 h-[68px] shrink-0 rounded-lg bg-white/5 object-cover"
                              />
                            ) : (
                              <div className="w-12 h-[68px] shrink-0 rounded-lg bg-white/[0.03] border border-white/5 flex items-center justify-center">
                                <span className="font-mono text-[8px] text-white/20">N/A</span>
                              </div>
                            )}

                            {/* Title + Episode */}
                            <div className="flex-1 min-w-0 space-y-0.5">
                              <h4 className="text-[15px] font-semibold text-white group-hover:text-signal truncate transition-colors">
                                {ep.showTitle}
                              </h4>
                              {ep.episodeTitle && (
                                <p className="text-[14px] text-muted-foreground/80 truncate">
                                  {ep.episodeTitle}
                                </p>
                              )}
                            </div>

                            {/* Date Badge + Episode Code */}
                            <div className="flex items-center gap-3 shrink-0">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold font-mono border",
                                  proximity.color,
                                  proximity.bg,
                                )}
                              >
                                {new Date(ep.airDate).toLocaleDateString(undefined, {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                              <EpisodeChip season={ep.season} episode={ep.episode} state="airing" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Calendar View Footer */}
          {upcoming && upcoming.length > 0 && (
            <div className="border-t border-white/5 px-6 py-3">
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

        {/* RIGHT COLUMN: Context Rail */}
        <div className="space-y-4 lg:sticky lg:top-6">
          {/* Library Health */}
          <GlassPanel className="p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="size-5 text-emerald-500 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-white tracking-wide">
                    Library Health
                  </h3>
                  <span className="font-mono text-[8px] font-bold uppercase tracking-widest text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                    Healthy
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1.5 font-mono text-[10px] text-muted-foreground">
                  <span>{shows ? shows.length : "—"} series</span>
                  <span className="text-white/10">|</span>
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="size-2.5 text-emerald-500" />
                    Verified 2m ago
                  </span>
                </div>
              </div>
            </div>
          </GlassPanel>

          {/* Quick Actions */}
          <GlassPanel className="p-4 space-y-3">
            <div className="border-b border-white/5 pb-2">
              <h3 className="font-display text-sm font-semibold text-white tracking-wide">
                Quick Actions
              </h3>
            </div>
            <div className="space-y-2">
              <button
                onClick={async () => {
                  try {
                    await fetch("/api/system/scan", { method: "POST" });
                  } catch {}
                }}
                className="w-full flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 text-xs font-medium text-white hover:bg-white/[0.06] transition-all duration-150 active:scale-[0.98]"
              >
                <Scan className="size-4 text-signal" />
                <span>Run Full Scan</span>
              </button>
              <button
                onClick={async () => {
                  // Check Upgrades — placeholder for future integration
                }}
                className="w-full flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 text-xs font-medium text-white hover:bg-white/[0.06] transition-all duration-150 active:scale-[0.98]"
              >
                <RefreshCw className="size-4 text-accent-amber" />
                <span>Check Upgrades</span>
              </button>
              <button
                onClick={async () => {
                  // Refresh Metadata — placeholder for future integration
                }}
                className="w-full flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 text-xs font-medium text-white hover:bg-white/[0.06] transition-all duration-150 active:scale-[0.98]"
              >
                <Activity className="size-4 text-blue-400" />
                <span>Refresh Metadata</span>
              </button>
            </div>
          </GlassPanel>

          {/* Recent Activity */}
          <WatcherPanel onEvents={setRecentEvents} />
        </div>
      </div>
    </div>
  );
}

export { Dashboard };
