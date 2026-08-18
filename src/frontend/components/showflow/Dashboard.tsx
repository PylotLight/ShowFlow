import {
  CheckIcon, Scan, Activity, ChevronRight, ChevronDown, ChevronUp, RotateCcw, RefreshCw, Menu,
} from "lucide-react";
import * as React from "react";

import { Skeleton } from "@frontend/components/ui/skeleton";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { AddShowDialog } from "@frontend/components/showflow/AddShowDialog";
import { HeaderActions } from "@frontend/lib/header-actions";
import type { ActivityEvent } from "@frontend/components/showflow/WatcherPanel";
import { PosterImage } from "@frontend/components/showflow/PosterImage";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { cn } from "@frontend/lib/utils";
import { expectedReleaseTime } from "@frontend/lib/airtime";
import type { EpisodeFileInfo } from "@frontend/components/showflow/EpisodeRow";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";

interface UpcomingEpisode {
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string;
  filePath: string | null;
  expectedReleaseAt?: string | null;
  file?: EpisodeFileInfo | null;
}

function formatAirTime(airDate: string) {
  if (!airDate.includes("T")) return null;
  const d = new Date(airDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Clock chip label: prefer the learned/forecast release time when the air
 *  date carries no time, otherwise fall back to the defined air time. */
function clockLabel(ep: UpcomingEpisode): string | null {
  return expectedReleaseTime(ep.expectedReleaseAt, ep.airDate);
}

/** Basis timestamp for any "when" logic - the learned release forecast wins
 *  over the raw air date, so dashboards show true expected availability. */
function whenBasis(ep: UpcomingEpisode): string {
  return ep.expectedReleaseAt || ep.airDate;
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

function getDateKeyFor(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ActionsMenu({ syncingAll, syncProgress, onScan, onRescan, onUpgrades, onMetadata }: {
  syncingAll: boolean;
  syncProgress: { synced: number; total: number; errors: number } | null;
  onScan: () => void;
  onRescan: () => void;
  onUpgrades: () => void;
  onMetadata: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center size-8 rounded-md border border-white/5 bg-white/[0.02] text-white/70 hover:text-white hover:bg-white/[0.06] transition-all"
      >
        <Menu className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-white/10 bg-[#181c2e] shadow-xl shadow-black/40 py-1.5 z-50 animate-fade-in [&>*]:px-3 [&>*]:py-2 [&>*]:text-xs [&>*]:font-medium [&>*]:text-white/80 [&>*]:flex [&>*]:items-center [&>*]:gap-2.5 [&>*]:w-full [&>*]:transition-colors">
          <button onClick={() => { onScan(); setOpen(false); }} className="hover:bg-white/[0.04]">
            <Scan className="size-4 text-signal" />
            Scan
          </button>
          <button onClick={() => { onRescan(); setOpen(false); }} className="hover:bg-white/[0.04]">
            <RotateCcw className="size-4 text-accent-amber" />
            Rescan Watch Folder
          </button>
          <button onClick={() => { onUpgrades(); setOpen(false); }} className="hover:bg-white/[0.04]">
            <RefreshCw className="size-4 text-blue-400" />
            Check Upgrades
          </button>
          <div className="border-t border-white/5 my-1" />
          <button onClick={() => { onMetadata(); setOpen(false); }} disabled={syncingAll} className="hover:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed">
            <Activity className={`size-4 text-purple-400 ${syncingAll ? 'animate-spin' : ''}`} />
            {syncingAll ? 'Syncing...' : 'Refresh Metadata'}
            {syncProgress && <span className="ml-auto text-white/50">{syncProgress.synced}/{syncProgress.total}</span>}
          </button>
        </div>
      )}
    </div>
  );
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
  onAddShow,
}: {
  onSelectShow: (show: ShowSummary) => void;
  onShowCalendar: () => void;
  onAddShow: () => void;
}) {
  const [shows, setShows] = React.useState<ShowSummary[] | null>(null);
  const [upcoming, setUpcoming] = React.useState<UpcomingEpisode[] | null>(null);
  const [recentEvents, setRecentEvents] = React.useState<ActivityEvent[]>([]);
  const [processingFiles, setProcessingFiles] = React.useState<string[]>([]);
  const [syncingAll, setSyncingAll] = React.useState(false);
  const [syncProgress, setSyncProgress] = React.useState<{ synced: number; total: number; errors: number } | null>(null);
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null);
  const [expandHistory, setExpandHistory] = React.useState(false);

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

  // Poll the system event log directly (no UI here — the full log now lives
  // in the notification bell) just to know when a show finishes syncing, is
  // removed, or is scanned, so the agenda can refresh itself.
  React.useEffect(() => {
    const poll = () => {
      fetch("/api/events?limit=50")
        .then((r) => r.json())
        .then((data: ActivityEvent[]) => setRecentEvents(data))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => clearInterval(id);
  }, []);

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

  // Split: past days → collapsible history; Today + future → primary agenda.
  const todayKey = getLocalDateKey(new Date().toISOString());
  const storyGroups = React.useMemo(() => ({
    history: groupedEpisodes
      .filter((g) => g.dateKey < todayKey)
      .sort((a, b) => (a.dateKey > b.dateKey ? -1 : 1)), // newest first
    upcoming: groupedEpisodes
      .filter((g) => g.dateKey >= todayKey)
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1)), // chronologically
  }), [groupedEpisodes, todayKey]);

  // Calendar strip day-click filters the upcoming list (toggle: click again to clear).
  const filteredUpcomingGroups = React.useMemo(() => (
    selectedDay
      ? storyGroups.upcoming.filter((g) => g.dateKey === selectedDay)
      : storyGroups.upcoming
  ), [storyGroups, selectedDay]);

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
    const map = new Map<string, UpcomingEpisode[]>();
    if (!upcoming) return map;
    upcoming.forEach((ep) => {
      const dateStr = getLocalDateKey(ep.airDate);
      const list = map.get(dateStr);
      if (list) list.push(ep); else map.set(dateStr, [ep]);
    });
    return map;
  }, [upcoming]);

  return (
    <div className="h-full flex flex-col gap-6">
      <HeaderActions>
        <div className="ml-auto flex items-center gap-3">
          <ActionsMenu
            syncingAll={syncingAll}
            syncProgress={syncProgress}
            onScan={async () => { try { await fetch("/api/system/scan", { method: "POST" }); } catch {} }}
            onRescan={async () => { try { await fetch("/api/system/watch/rescan", { method: "POST" }); } catch {} }}
            onUpgrades={async () => {}}
            onMetadata={async () => {
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
          />
          <AddShowDialog onAdded={onAddShow} />
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

        {/* Primary Agenda — the old "Live Events" side panel duplicated the
            notification bell's activity log 1:1, so it's gone; that panel
            now has the full width to itself. */}
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
                const dateStr = getDateKeyFor(date);
                const dayEps = episodesByDate.get(dateStr) || [];
                const count = dayEps.length;
                const isToday = dateStr === todayKey;
                const isSelected = selectedDay === dateStr;
                return (
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => setSelectedDay(isSelected ? null : dateStr)}
                    className={cn(
                      "flex flex-col items-center rounded-md px-1 py-1 min-w-[34px] transition-all duration-150 cursor-pointer",
                      count > 0
                        ? "bg-signal/8 border border-signal/12 hover:bg-signal/15"
                        : "bg-transparent border border-transparent hover:bg-white/[0.04]",
                      isToday && "ring-1 ring-signal/30",
                      isSelected && "bg-signal/20 border-signal/50 ring-1 ring-signal/50",
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
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dense Episode List */}
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {upcoming === null ? (
              <DashboardSkeleton />
            ) : upcoming.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground text-xs font-mono">
                NO EPISODES IN THE LAST 3 DAYS OR NEXT 7 DAYS.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Recently Released — collapsed by default so past days don't
                    compete with the primary agenda */}
                {storyGroups.history.length > 0 && (
                  <div className="border border-white/5 bg-white/[0.01] rounded-md px-2 py-1">
                    <button
                      onClick={() => setExpandHistory(!expandHistory)}
                      className="w-full flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors py-1 text-left"
                    >
                      {expandHistory
                        ? <ChevronUp className="size-3 shrink-0" />
                        : <ChevronDown className="size-3 shrink-0" />}
                      Recently Released
                      <span className="text-white/25 normal-case font-normal">
                        ({storyGroups.history.reduce((n, g) => n + g.items.length, 0)} ep{storyGroups.history.reduce((n, g) => n + g.items.length, 0) !== 1 ? 's' : ''})
                      </span>
                      <span className="flex-1" />
                      {storyGroups.history.slice(0, expandHistory ? 0 : 2).map((g) =>
                        g.items.slice(0, 2).map((ep) => (
                          <span
                            key={`${ep.showTitle}-${ep.season}-${ep.episode}-hint`}
                            className="text-white/25 lowercase font-normal normal-case truncate max-w-[110px] hidden sm:inline"
                          >
                            {ep.showTitle} S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                          </span>
                        ))
                      )}
                    </button>
                    {expandHistory && (
                      <div className="pb-1 space-y-0.5">
                        {storyGroups.history.map((group) => (
                          <div key={group.dateKey} className="space-y-0.5">
                            <h4 className="font-mono text-[9px] font-bold uppercase tracking-wider text-white/25 border-b border-white/5 pb-0.5 mb-0.5 mt-1.5">
                              {group.label}
                            </h4>
                            {group.items.map((ep, i) => {
                              const showObj = getMatchingShow(ep.showTitle);
                              return (
                                <div
                                  key={`${ep.showTitle}-${ep.season}-${ep.episode}-${i}`}
                                  onClick={() => { if (showObj) onSelectShow(showObj); }}
                                  className="group flex items-center gap-2 rounded px-1.5 py-0.5 cursor-pointer transition-all duration-150 hover:bg-white/[0.03]"
                                >
                                  {showObj ? (
                                    <PosterImage
                                      showId={showObj.id}
                                      alt={ep.showTitle}
                                      className="w-[16px] h-[24px] shrink-0 rounded-sm bg-white/5 object-cover opacity-50"
                                    />
                                  ) : (
                                    <div className="w-[16px] h-[24px] shrink-0 rounded-sm bg-white/[0.03] border border-white/5 flex items-center justify-center opacity-50">
                                      <span className="font-mono text-[5px] text-white/20">N/A</span>
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                                    <span className="text-xs font-medium text-white/45 truncate transition-colors group-hover:text-white/60">
                                      {ep.showTitle}
                                    </span>
                                    <span className="text-[10px] text-white/25 font-mono shrink-0">
                                      S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                                    </span>
                                  </div>
                                  {ep.filePath && (
                                    <span className="flex items-center gap-1 rounded-full bg-signal/8 px-1 py-0.5 font-mono text-[7px] font-bold uppercase tracking-wider text-signal/60 border border-signal/10">
                                      <CheckIcon className="size-2" strokeWidth={3} />
                                      Available
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-white/30 shrink-0 leading-none">
                                    {getCompactDate(ep.airDate)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Primary upcoming list: Today → Tomorrow → rest, today gets a hero accent */}
                {filteredUpcomingGroups.map((group, gi) => {
                  const isToday = group.dateKey === todayKey;
                  return (
                  <div
                    key={group.dateKey}
                    className={cn(
                      "space-y-0.5 animate-fade-in",
                      isToday && "rounded-lg bg-signal/[0.04] border border-signal/10 -mx-1 px-3 py-2",
                    )}
                    style={{ animationDelay: `${gi * 60}ms` }}
                  >
                    <h3 className={cn(
                      "font-mono text-[10px] font-bold uppercase tracking-wider pb-1 mb-1 flex items-center gap-1.5",
                      isToday
                        ? "text-signal border-b border-signal/15"
                        : "text-white/30 border-b border-white/5",
                    )}>
                      {isToday && <span className="inline-block size-1.5 rounded-full bg-signal animate-pulse" />}
                      {group.label}
                      {isToday && (
                        <span className="ml-auto normal-case font-normal text-[10px] text-signal/70">
                          {group.items.length} ep{group.items.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </h3>
                    {(() => {
                      const nowLineIdx = isToday ? group.items.findIndex((ep) => !isPast(whenBasis(ep))) : -1;
                      const hasNowLine = nowLineIdx > 0;
                      return group.items.map((ep, i) => {
                      const showObj = getMatchingShow(ep.showTitle);
                      const prox = getRowProximity(whenBasis(ep));
                      const time = clockLabel(ep);
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
                          className="group flex items-center gap-2.5 rounded-md px-2 py-1 cursor-pointer transition-all duration-150 hover:bg-white/[0.03]"
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
                              <span
                                className="text-[12px] text-white/40 truncate hidden sm:inline"
                                title={ep.episodeTitle}
                              >
                                · {ep.episodeTitle}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {ep.filePath && (
                              <MediaBadges media={ep.file?.media} max={3} className="hidden lg:inline-flex" />
                            )}
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
                  );
                })}

                {/* Day-filter offset banner when a calendar day is selected */}
                {selectedDay && filteredUpcomingGroups.length === 0 && storyGroups.upcoming.length > 0 && (
                  <div className="text-center py-10">
                    <p className="text-muted-foreground text-xs font-mono">No episodes on {new Date(selectedDay + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}.</p>
                    <button
                      onClick={() => setSelectedDay(null)}
                      className="mt-2 font-mono text-[10px] font-bold text-signal hover:text-signal/80 uppercase tracking-wider transition-colors"
                    >
                      Clear filter
                    </button>
                  </div>
                )}
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
      </div>
    </div>
  );
}

export { Dashboard };
