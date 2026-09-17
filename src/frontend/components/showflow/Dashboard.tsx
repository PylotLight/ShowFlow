import {
  CheckIcon, Scan, Activity, ChevronRight, ChevronDown, ChevronUp, RotateCcw, RefreshCw, Menu, SearchIcon,
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
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";

interface UpcomingEpisode {
  showTitle: string;
  episodeTitle?: string;
  season: number;
  episode: number;
  airDate: string | null;
  filePath: string | null;
  expectedReleaseAt?: string | null;
  file?: EpisodeFileInfo | null;
}

/** Returns true when the episode has a usable air date (TBA episodes don't). */
function hasKnownAirDate(airDate: string | null): boolean {
  if (!airDate) return false;
  return !isNaN(new Date(airDate).getTime());
}

function formatAirTime(airDate: string | null) {
  if (!airDate || !airDate.includes("T")) return null;
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
 *  over the raw air date, so dashboards show true expected availability.
 *  Null when the episode is unscheduled (TBA). */
function whenBasis(ep: UpcomingEpisode): string | null {
  return ep.expectedReleaseAt || ep.airDate || null;
}

function getLocalDateKey(airDate: string | null): string {
  const d = new Date(airDate ?? "");
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getRelativeDayLabel(airDate: string | null): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(airDate ?? "");
  if (isNaN(d.getTime())) return "";
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 0) return `${Math.abs(diffDays)} days ago`;
  return target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function getCompactDate(airDate: string | null): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(airDate ?? "");
  if (isNaN(d.getTime())) return "";
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

function isPast(airDate: string | null): boolean {
  if (!airDate) return false;
  const t = new Date(airDate).getTime();
  return !isNaN(t) && t <= Date.now();
}

function formatNowTime(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Proximity dot for an episode row. Color lives on the dot and timestamp
 *  only — titles stay near-white so hue never doubles as meaning. */
function getRowDot(airDate: string | null): string {
  if (!airDate) return "bg-white/30";
  const now = new Date();
  const target = new Date(airDate);
  if (isNaN(target.getTime())) return "bg-white/30";
  const diffTime = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return "bg-white/20";
  if (diffDays <= 1) return "bg-signal";
  if (diffDays <= 3) return "bg-accent-amber";
  return "bg-white/30";
}

/** Explicit acquisition state, derived from calendar fields only:
 *  file on disk → Available; aired with no file → Awaiting release
 *  (aired but not yet grabbed); otherwise Scheduled. */
function acquisition(ep: UpcomingEpisode): "available" | "awaiting" | "scheduled" {
  if (ep.filePath) return "available";
  if (isPast(whenBasis(ep))) return "awaiting";
  return "scheduled";
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
  // Offset (in days) of the calendar strip window — prev/next shift it,
  // Today snaps it back.
  const [stripOffset, setStripOffset] = React.useState(0);
  // Release-search target for the per-episode browse button (agenda rows).
  const [searchTarget, setSearchTarget] = React.useState<{
    showId: string; showTitle: string; season: number; episode: number;
  } | null>(null);

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

  // Dated episodes only — unscheduled (TBA) episodes are excluded from the
  // dashboard entirely.
  const datedUpcoming = React.useMemo(() => {
    if (!upcoming) return null;
    return upcoming.filter((ep) => hasKnownAirDate(ep.airDate));
  }, [upcoming]);

  const groupedEpisodes = React.useMemo(() => {
    if (!datedUpcoming) return [];
    const groups: { [key: string]: UpcomingEpisode[] } = {};
    datedUpcoming.forEach((ep) => {
      const dateKey = getLocalDateKey(ep.airDate);
      if (!dateKey) return;
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(ep);
    });
    return Object.entries(groups).map(([dateKey, items]) => {
      const sample = items[0]?.airDate ?? null;
      return {
        dateKey,
        label: getRelativeDayLabel(sample),
        items: [...items].sort((a, b) => {
          const at = new Date(a.airDate ?? "").getTime();
          const bt = new Date(b.airDate ?? "").getTime();
          return at - bt;
        }),
      };
    });
  }, [datedUpcoming]);

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

  // Calendar strip day-click filters the list (toggle: click again to clear).
  // A selected day searches ALL groups — past days live in history, so
  // filtering upcoming-only rendered "No episodes" for any day with a count.
  // The selected day renders in the same full view as today.
  const visibleGroups = React.useMemo(() => {
    const all = [...storyGroups.upcoming, ...storyGroups.history];
    if (!selectedDay) return storyGroups.upcoming;
    return all
      .filter((g) => g.dateKey === selectedDay)
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  }, [storyGroups, selectedDay]);

  const uniqueShowsCount = React.useMemo(() => {
    if (!datedUpcoming) return 0;
    return new Set(datedUpcoming.map((ep) => ep.showTitle)).size;
  }, [datedUpcoming]);

  // Visible window of the agenda, for the scoped header total
  // ("14 episodes · 12 series · Sep 13 – Sep 20").
  const agendaRange = React.useMemo(() => {
    if (!datedUpcoming || datedUpcoming.length === 0) return null;
    const keys = datedUpcoming
      .map((ep) => getLocalDateKey(ep.airDate))
      .filter(Boolean)
      .sort();
    if (keys.length === 0) return null;
    const fmt = (k: string) =>
      new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const firstKey = keys[0];
    const lastKey = keys[keys.length - 1];
    if (!firstKey || !lastKey) return null;
    const first = fmt(firstKey);
    const last = fmt(lastKey);
    return first === last ? first : `${first} – ${last}`;
  }, [datedUpcoming]);

  const getMatchingShow = (title: string) =>
    shows?.find((s) => s.title.toLowerCase() === title.toLowerCase());

  const calendarDays = React.useMemo(() => {
    const today = new Date();
    return Array.from({ length: 11 }, (_, i) => {
      const date = new Date(today);
      date.setDate(today.getDate() + i - 3 + stripOffset);
      return date;
    });
  }, [stripOffset]);

  // Month(s) spanned by the visible strip window, e.g. "September" or "Sep – Oct".
  const stripMonths = React.useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
    const first = calendarDays[0];
    const last = calendarDays[calendarDays.length - 1];
    if (!first || !last) return null;
    const a = fmt(first);
    const b = fmt(last);
    if (a === b) return first.toLocaleDateString(undefined, { month: "long" });
    return `${a} – ${b}`;
  }, [calendarDays]);

  const episodesByDate = React.useMemo(() => {
    const map = new Map<string, UpcomingEpisode[]>();
    if (!datedUpcoming) return map;
    datedUpcoming.forEach((ep) => {
      const dateStr = getLocalDateKey(ep.airDate);
      if (!dateStr) return;
      const list = map.get(dateStr);
      if (list) list.push(ep); else map.set(dateStr, [ep]);
    });
    return map;
  }, [datedUpcoming]);

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
                <h2 className="font-display text-xl font-bold text-white mt-0.5 leading-tight">
                  Upcoming
                </h2>
              </div>
              {datedUpcoming && (
                <div className="text-right font-mono text-xs text-muted-foreground">
                  <span className="text-white font-semibold">{datedUpcoming.length}</span>
                  {" "}episode{datedUpcoming.length !== 1 && "s"}
                  <span className="text-white/20 mx-1.5">|</span>
                  <span className="text-white font-semibold">{uniqueShowsCount}</span>
                  {" "}series
                  {agendaRange && (
                    <>
                      <span className="text-white/20 mx-1.5">|</span>
                      <span className="text-white/60">{agendaRange}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Recently Released — newest first, above the agenda;
              collapsed by default */}
          {storyGroups.history.length > 0 && (
            <div className="border-b border-white/5 px-5 py-1">
              <button
                onClick={() => setExpandHistory(!expandHistory)}
                className="w-full flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-white/60 hover:text-white/90 transition-colors py-1 text-left"
              >
                {expandHistory
                  ? <ChevronUp className="size-3 shrink-0" />
                  : <ChevronDown className="size-3 shrink-0" />}
                Recently Released
                <span className="text-white/50 normal-case font-normal">
                  ({storyGroups.history.reduce((n, g) => n + g.items.length, 0)} ep{storyGroups.history.reduce((n, g) => n + g.items.length, 0) !== 1 ? 's' : ''})
                </span>
                <span className="flex-1" />
                {storyGroups.history.slice(0, expandHistory ? 0 : 2).map((g) =>
                  g.items.slice(0, 2).map((ep) => (
                    <span
                      key={`${ep.showTitle}-${ep.season}-${ep.episode}-hint`}
                      className="text-white/50 lowercase font-normal normal-case truncate max-w-[110px] hidden sm:inline"
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
                      <h4 className="font-mono text-[9px] font-bold uppercase tracking-wider text-white/55 border-b border-white/5 pb-0.5 mb-0.5 mt-1.5">
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
                                size="card"
                                className="w-[16px] h-[24px] shrink-0 rounded-sm bg-white/5 object-cover opacity-50"
                              />
                            ) : (
                              <div className="w-[16px] h-[24px] shrink-0 rounded-sm bg-white/[0.03] border border-white/5 flex items-center justify-center opacity-50">
                                <span className="font-mono text-[5px] text-white/20">N/A</span>
                              </div>
                            )}
                            <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                              <span
                                title={ep.showTitle}
                                className="text-xs font-medium text-white/70 truncate transition-colors group-hover:text-white"
                              >
                                {ep.showTitle}
                              </span>
                              <span className="text-[10px] text-white/55 font-mono shrink-0">
                                S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                              </span>
                            </div>
                            {ep.filePath ? (
                              <span className="flex items-center gap-1 rounded-full bg-signal/8 px-1 py-0.5 font-mono text-[7px] font-bold uppercase tracking-wider text-signal/60 border border-signal/10">
                                <CheckIcon className="size-2" strokeWidth={3} />
                                Available
                              </span>
                            ) : (
                              <span
                                title="Aired but not yet grabbed — check Pipeline or grab manually"
                                className="rounded-full bg-accent-amber/10 px-1 py-0.5 font-mono text-[7px] font-bold uppercase tracking-wider text-accent-amber border border-accent-amber/20"
                              >
                                Awaiting release
                              </span>
                            )}
                            {/* Missed item: aired with no file — one click opens
                                the per-episode release browser (same dialog the
                                agenda rows use), scoped to this exact episode. */}
                            {!ep.filePath && showObj && (
                              <button
                                type="button"
                                title={`Browse releases for ${ep.showTitle} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSearchTarget({
                                    showId: showObj.id,
                                    showTitle: ep.showTitle,
                                    season: ep.season,
                                    episode: ep.episode,
                                  });
                                }}
                                className="flex items-center gap-1 rounded-full bg-signal/10 px-1.5 py-0.5 font-mono text-[7px] font-bold uppercase tracking-wider text-signal border border-signal/20 hover:bg-signal/20 transition-colors"
                              >
                                <SearchIcon className="size-2" strokeWidth={3} />
                                Browse
                              </button>
                            )}
                            <span className="text-[10px] font-mono text-white/60 shrink-0 leading-none">
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

          {/* Compact Calendar Strip */}
          <div className="border-b border-white/5 px-5 py-2.5 flex items-center gap-2">
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                title="Previous days"
                aria-label="Previous days"
                onClick={() => setStripOffset((o) => o - 7)}
                className="flex items-center justify-center size-6 rounded-md text-white/50 hover:text-white hover:bg-white/[0.06] transition-all"
              >
                <ChevronRight className="size-3.5 rotate-180" />
              </button>
              <button
                type="button"
                title="Jump to today"
                onClick={() => { setStripOffset(0); setSelectedDay(todayKey); }}
                className="rounded-md px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-white/60 hover:text-signal hover:bg-signal/10 transition-all"
              >
                Today
              </button>
              <button
                type="button"
                title="Next days"
                aria-label="Next days"
                onClick={() => setStripOffset((o) => o + 7)}
                className="flex items-center justify-center size-6 rounded-md text-white/50 hover:text-white hover:bg-white/[0.06] transition-all"
              >
                <ChevronRight className="size-3.5" />
              </button>
              {stripMonths && (
                <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-white/40">
                  {stripMonths}
                </span>
              )}
            </div>
            <div className="flex gap-1 min-w-0 overflow-x-auto">
              {calendarDays.map((date) => {
                const dateStr = getDateKeyFor(date);
                const dayEps = episodesByDate.get(dateStr) || [];
                const count = dayEps.length;
                const isToday = dateStr === todayKey;
                const isSelected = selectedDay === dateStr;
                const fullLabel = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
                return (
                  <button
                    key={dateStr}
                    type="button"
                    title={`${fullLabel} · ${count} episode${count !== 1 ? "s" : ""}`}
                    aria-label={`${fullLabel}, ${count} episodes`}
                    aria-pressed={isSelected}
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
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-white/60">
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span
                      className={cn(
                        "font-display text-xs font-bold leading-tight",
                        count > 0 ? "text-white" : "text-white/50",
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
            {datedUpcoming === null ? (
              <DashboardSkeleton />
            ) : datedUpcoming.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground text-xs font-mono">
                NO EPISODES IN THE LAST 3 DAYS OR NEXT 7 DAYS.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Primary upcoming list: Today → Tomorrow → rest, today gets a hero accent.
                    With a day selected, that day's group renders here in full. */}
                {visibleGroups.map((group, gi) => {
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
                        : "text-white/60 border-b border-white/5",
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
                      const dot = getRowDot(whenBasis(ep));
                      const state = acquisition(ep);
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
                              size="card"
                                className="w-[18px] h-[27px] shrink-0 rounded-sm bg-white/5 object-cover"
                            />
                          ) : (
                            <div className="w-[18px] h-[27px] shrink-0 rounded-sm bg-white/[0.03] border border-white/5 flex items-center justify-center">
                              <span className="font-mono text-[5px] text-white/20">N/A</span>
                            </div>
                          )}
                          <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
                          <div className="flex-1 min-w-0 flex items-baseline gap-1.5">
                            <span
                              title={ep.showTitle}
                              className="text-sm font-semibold truncate transition-colors text-white/75 group-hover:text-white"
                            >
                              {ep.showTitle}
                            </span>
                            <span className="text-[11px] text-white/55 font-mono shrink-0">
                              S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                            </span>
                            {ep.episodeTitle && (
                              <span
                                className="text-[12px] text-white/60 truncate hidden sm:inline"
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
                            {state === "available" && (
                              <span className="flex items-center gap-1 rounded-full bg-signal/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-signal border border-signal/15">
                                <CheckIcon className="size-2.5" strokeWidth={3} />
                                Available
                              </span>
                            )}
                            {state === "awaiting" && (
                              <span
                                title="Aired but not yet grabbed — check Pipeline or grab manually"
                                className="rounded-full bg-accent-amber/10 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-accent-amber border border-accent-amber/20"
                              >
                                Awaiting release
                              </span>
                            )}
                            {state === "scheduled" && (
                              <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider text-white/50 border border-white/10">
                                Scheduled
                              </span>
                            )}
                            {showObj && (
                              <button
                                type="button"
                                title={`Browse releases for ${ep.showTitle} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`}
                                aria-label={`Browse releases for ${ep.showTitle} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSearchTarget({
                                    showId: showObj.id,
                                    showTitle: ep.showTitle,
                                    season: ep.season,
                                    episode: ep.episode,
                                  });
                                }}
                                className="flex items-center justify-center size-5 rounded text-white/35 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-signal hover:bg-signal/10 transition-all"
                              >
                                <SearchIcon className="size-3" />
                              </button>
                            )}
                            <span className="text-[11px] font-mono text-white/60 shrink-0 leading-none">
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

                {/* Day-filter offset banner when a calendar day is selected
                    but nothing aired that day */}
                {selectedDay && visibleGroups.length === 0 && (
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
          {datedUpcoming && datedUpcoming.length > 0 && (
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

      {/* Per-episode release browser (agenda rows) — manual search with the
          dialog's own auto-grab, scoped to the exact episode. */}
      {searchTarget && (
        <ReleaseSearchDialog
          open={!!searchTarget}
          onOpenChange={(open) => { if (!open) setSearchTarget(null); }}
          showId={searchTarget.showId}
          showTitle={searchTarget.showTitle}
          season={searchTarget.season}
          episode={searchTarget.episode}
          onGrabbed={() => fetchShowsAndCalendar()}
        />
      )}
    </div>
  );
}

export { Dashboard };
