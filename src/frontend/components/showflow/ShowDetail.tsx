import { Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, DownloadIcon, FolderArchive, FolderSearch, GitCompareArrows, Loader2Icon, Maximize2, Minimize2, MoreHorizontal, PencilIcon, RefreshCwIcon, SearchIcon, XIcon, Clock } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { EpisodeRow, type EpisodeData, type ColumnDef } from "@frontend/components/showflow/EpisodeRow";
import { ManageSourcesDialog } from "@frontend/components/showflow/ManageSourcesDialog";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { EpisodeMappingDialog } from "@frontend/components/showflow/EpisodeMappingDialog";
import { EpisodeDuplicatesDialog } from "@frontend/components/showflow/EpisodeDuplicatesDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { formatDelayMinutes } from "@frontend/lib/airtime";


interface SeasonStat {
  seasonNumber: number;
  episodeCount: number;
  trackedCount: number;
}

interface SeasonWithEpisodes extends SeasonStat {
  episodes: EpisodeData[];
}

interface Profile {
  id: string;
  name: string;
}

const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'airDate', label: 'Air Date', visible: true },
  { id: 'status', label: 'Status', visible: true },
  { id: 'actions', label: 'Actions', visible: true },
  { id: 'search', label: 'Search', visible: false },
];

function loadColumns(): ColumnDef[] {
  try {
    const saved = localStorage.getItem('showflow-columns');
    if (saved) {
      const parsed = JSON.parse(saved) as ColumnDef[];
      return DEFAULT_COLUMNS.map(def => ({ ...def, visible: parsed.find((p: ColumnDef) => p.id === def.id)?.visible ?? def.visible }));
    }
  } catch {}
  return DEFAULT_COLUMNS;
}

function saveColumns(cols: ColumnDef[]) {
  try { localStorage.setItem('showflow-columns', JSON.stringify(cols)); } catch {}
}

// Which release search/grab is currently in flight - used to disable/spin
// the right button without a big lookup table. `season:{n}` covers a
// season-level auto-grab; `ep:{season}:{episode}` covers one episode.
type GrabTarget = string | null;

// What the ReleaseSearchDialog is currently showing - undefined episode
// means a season-level (pack) search.
interface SearchTarget {
  season: number;
  episode?: number;
}

function ShowDetail({ show, onBack, modal = false, onToggleExpand, expanded }: { show: ShowSummary; onBack: () => void; modal?: boolean; onToggleExpand?: () => void; expanded?: boolean }) {
  const [seasons, setSeasons] = React.useState<SeasonStat[] | null>(null);
  // All seasons' episodes, keyed by season number. One unified list, latest
  // season first (specials last) — no season tabs.
  const [episodesBySeason, setEpisodesBySeason] = React.useState<Record<number, EpisodeData[]>>({});
  const [collapsed, setCollapsed] = React.useState<Record<number, boolean>>({});
  const [loadingEpisodes, setLoadingEpisodes] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "available" | "missing">("all");
  const [columnConfig, setColumnConfig] = React.useState<ColumnDef[]>(loadColumns);
  const [showColumnMenu, setShowColumnMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // Single options menu shared by desktop + mobile: config, organize and
  // danger actions with descriptions, instead of split top/bottom buttons.
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const optionsMenuRef = React.useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [profile, setProfile] = React.useState<string>(show.profile || "standard");

  const [folderProfiles, setFolderProfiles] = React.useState<{ id: string; name: string; root_folder_path: string }[]>([]);
  const [rootFolderPath, setRootFolderPath] = React.useState<string | null>(null);
  const [rootFolderSaving, setRootFolderSaving] = React.useState(false);
  const [seriesType, setSeriesType] = React.useState<string>("standard");
  const [releaseDelayMinutes, setReleaseDelayMinutes] = React.useState<number | null>(null);

  const [manageSourcesOpen, setManageSourcesOpen] = React.useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = React.useState(false);
  const [searchTarget, setSearchTarget] = React.useState<SearchTarget | null>(null);
  const [grabTarget, setGrabTarget] = React.useState<GrabTarget>(null);
  const [relocating, setRelocating] = React.useState(false);
  const [organizing, setOrganizing] = React.useState(false);
  const [organizePreview, setOrganizePreview] = React.useState<{
    namingPattern: string;
    items: { season: number; episode: number; currentPath: string; targetPath: string; action: 'correct' | 'move' }[];
    wouldChange: boolean;
  } | null>(null);
  const [organizeApplying, setOrganizeApplying] = React.useState(false);
  const [renamingFolder, setRenamingFolder] = React.useState(false);
  const [renameSeriesOpen, setRenameSeriesOpen] = React.useState(false);
  const [renameSeriesTitle, setRenameSeriesTitle] = React.useState("");
  const [renamingSeries, setRenamingSeries] = React.useState(false);
  const [renamePreview, setRenamePreview] = React.useState<{
    currentFolderPath: string;
    currentFolderName: string;
    sanitizedTitle: string;
    targetFolderPath: string;
    wouldChange: boolean;
    episodesAffected: number;
  } | null>(null);
  const [moveDialog, setMoveDialog] = React.useState<{ oldRoot: string; newRoot: string; profileName: string; profileId: string } | null>(null);

  const [mappingOpen, setMappingOpen] = React.useState(false);
  const [mappingHealth, setMappingHealth] = React.useState<string>("none");
  // Banner backdrop cycler: alternate backdrops the provider knows about.
  const [backdropOptions, setBackdropOptions] = React.useState<{ index: number; url: string }[]>([]);
  const [backdropIndex, setBackdropIndex] = React.useState(0);

  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);
  const statusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashStatus(text: string, ok = true) {
    setStatus({ ok, text });
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 6000);
  }

  React.useEffect(() => {
    // Quality profiles (points-system: 1080p/h265/etc via custom formats) -
    // distinct from the show_profiles folder presets used at Add Show time.
    fetch("/api/profiles").then(r => r.json()).then(data => setProfiles(Array.isArray(data) ? data : [])).catch(() => setProfiles([]));
  }, []);

  React.useEffect(() => {
    // Root-folder presets ("Shows" vs "Anime" etc.) - only ever applied at
    // Add Show time previously, so surfacing + editing them here is what
    // lets an existing show move between categories after the fact.
    fetch("/api/show-profiles").then(r => r.json()).then(data => setFolderProfiles(Array.isArray(data) ? data : [])).catch(() => setFolderProfiles([]));
  }, []);

  React.useEffect(() => {
    setBackdropOptions([]);
    setBackdropIndex(0);
    fetch(`/api/shows/${show.id}/images/backdrops`).then(r => r.json()).then(data => {
      const options = Array.isArray(data.options) ? data.options : [];
      setBackdropOptions(options);
      setBackdropIndex(typeof data.selected === "number" ? data.selected : 0);
    }).catch(() => {});
  }, [show.id]);

  function cycleBackdrop(dir: 1 | -1) {
    if (backdropOptions.length < 2) return;
    const next = (backdropIndex + dir + backdropOptions.length) % backdropOptions.length;
    setBackdropIndex(next);
    fetch(`/api/shows/${show.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { backdropIndex: next } }),
    }).catch(() => {});
  }

  React.useEffect(() => {
    setRootFolderPath(null);
    fetch(`/api/shows/${show.id}`).then(r => r.json()).then(data => {
      const resolvedType = data.seriesType ?? data.config?.seriesType ?? (show.providerType === 'anilist' ? 'anime' : 'standard');
      setSeriesType(resolvedType);
      setReleaseDelayMinutes(data.releaseDelayMinutes ?? null);
      if (data.rootFolderPath) {
        setRootFolderPath(data.rootFolderPath);
      }
      const epMap = data.config?.episodeMapping;
      setMappingHealth(epMap?.health ?? 'none');
    }).catch(() => {});
  }, [show.id, show.providerType]);

  React.useEffect(() => {
    if (rootFolderPath === null && seriesType && folderProfiles.length > 0) {
      const match = findProfileForType(seriesType);
      if (match) setRootFolderPath(match.root_folder_path);
    }
  }, [seriesType, folderProfiles.length]);

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowColumnMenu(false);
      }
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(e.target as Node)) {
        setOptionsOpen(false);
      }
    }
    if (showColumnMenu || optionsOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showColumnMenu, optionsOpen]);

  // Seasons display order: latest first, specials (season 0) last.
  function orderSeasons<T extends SeasonStat>(list: T[]): T[] {
    return [...list].sort((a, b) => {
      if (a.seasonNumber === 0) return 1;
      if (b.seasonNumber === 0) return -1;
      return b.seasonNumber - a.seasonNumber;
    });
  }

  function seasonLabel(n: number): string {
    return n === 0 ? "Specials" : `Season ${n}`;
  }

  async function loadAllEpisodes() {
    setLoadingEpisodes(true);
    try {
      const r = await fetch(`/api/shows/${show.id}/episodes`);
      const data: { seasons: SeasonWithEpisodes[] } = await r.json();
      const list = Array.isArray(data.seasons) ? data.seasons : [];
      const ordered = orderSeasons(list);
      setSeasons(ordered.map(({ episodes: _e, ...stats }) => stats));
      setCollapsed((prev) => {
        // Preserve the user's collapse choices across refreshes; new
        // seasons default to collapsed unless they're the latest.
        const next: Record<number, boolean> = {};
        ordered.forEach((s, i) => { next[s.seasonNumber] = prev[s.seasonNumber] ?? i !== 0; });
        return next;
      });
      const buckets: Record<number, EpisodeData[]> = {};
      // Episodes within a season run newest-first (finale on top), matching
      // the seasons' latest-first order.
      for (const s of ordered) {
        buckets[s.seasonNumber] = [...(s.episodes ?? [])].sort((a, b) => b.episode - a.episode);
      }
      setEpisodesBySeason(buckets);
    } catch {
      // Keep previous state on failure; the list simply doesn't refresh.
    } finally {
      setLoadingEpisodes(false);
    }
  }

  React.useEffect(() => {
    setSeasons(null);
    setEpisodesBySeason({});
    setCollapsed({});
    loadAllEpisodes();
  }, [show.id]);

  const orderedSeasons = React.useMemo(() => (seasons ? orderSeasons(seasons) : []), [seasons]);

  const episodesLoaded = Object.keys(episodesBySeason).length > 0;

  // Per-season filtered episodes for the unified list. While a
  // file-state filter is active every section is force-expanded so matches
  // are never hidden inside a collapsed season.
  const forceExpand = filter !== "all";
  const sections = React.useMemo(() => {
    const hasFile = (ep: EpisodeData) => !!ep.filePath;
    return orderedSeasons.map((s) => {
      const all = episodesBySeason[s.seasonNumber] ?? [];
      const eps = filter === "all" ? all : all.filter((ep) => (filter === "available" ? hasFile(ep) : !hasFile(ep)));
      return { season: s, all, episodes: eps };
    });
  }, [orderedSeasons, episodesBySeason, filter]);

  const overallAvailable = sections.reduce((a, s) => a + s.all.filter((e) => !!e.filePath).length, 0);
  const overallTotal = sections.reduce((a, s) => a + s.all.length, 0);

  function updateEpisodeBucket(season: number, fn: (eps: EpisodeData[]) => EpisodeData[]) {
    setEpisodesBySeason((prev) => {
      const cur = prev[season];
      if (!cur) return prev;
      return { ...prev, [season]: fn(cur) };
    });
  }

  async function toggleTracked(episode: EpisodeData, tracked: boolean) {
    updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, tracked } : e)));
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/tracked`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracked }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, tracked: !tracked } : e)));
    }
  }

  async function handleSearchMode(episode: EpisodeData, mode: 'auto' | 'interactive') {
    updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, searchMode: mode } : e)));
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/search`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      updateEpisodeBucket(episode.season, (eps) => eps.map((e) => (e.episode === episode.episode ? { ...e, searchMode: episode.searchMode === 'auto' ? 'interactive' : 'auto' } : e)));
    }
  }

  async function handleProfileChange(next: string) {    const prev = profile;
    setProfile(next);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: next }),
      });
      if (!res.ok) throw new Error("Failed to update profile");
    } catch {
      setProfile(prev);
      flashStatus("Failed to update quality profile.", false);
    }
  }

  function handleSeriesTypeChange(v: string) {
    const match = findProfileForType(v);
    const body: Record<string, any> = { seriesType: v };
    if (match && match.root_folder_path !== rootFolderPath) {
      body.rootFolderPath = match.root_folder_path;
    }
    setSeriesType(v);
    if (match && match.root_folder_path !== rootFolderPath) {
      setRootFolderPath(match.root_folder_path);
    }
    fetch(`/api/shows/${show.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.ok && flashStatus(`Type set to "${v}".`)).catch(() => flashStatus("Failed to update.", false));
  }

  const matchedFolderProfileId = React.useMemo(
    () => folderProfiles.find(fp => fp.root_folder_path === rootFolderPath)?.id ?? "",
    [folderProfiles, rootFolderPath],
  );

  function findProfileForType(type: string) {
    if (!folderProfiles.length) return null;
    if (type === "anime") {
      return folderProfiles.find(fp =>
        fp.id.toLowerCase().includes("anime") || fp.name.toLowerCase().includes("anime")
      ) ?? folderProfiles[0];
    }
    return folderProfiles.find(fp =>
      !fp.id.toLowerCase().includes("anime") && !fp.name.toLowerCase().includes("anime")
    ) ?? folderProfiles[0];
  }

  async function handleRootFolderChange(profileId: string) {
    const target = folderProfiles.find(fp => fp.id === profileId);
    if (!target) return;
    if (!rootFolderPath) {
      executeRootFolderChange(target);
      return;
    }
    setMoveDialog({ oldRoot: rootFolderPath, newRoot: target.root_folder_path, profileName: target.name, profileId: target.id });
  }

  async function executeRootFolderChange(target: { id: string; name: string; root_folder_path: string }) {
    const prevPath = rootFolderPath;
    setRootFolderPath(target.root_folder_path);
    setRootFolderSaving(true);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootFolderPath: target.root_folder_path }),
      });
      if (!res.ok) throw new Error("Failed to update root folder");
      flashStatus(`Root folder set to "${target.name}".`);
    } catch {
      setRootFolderPath(prevPath);
      flashStatus("Failed to update root folder.", false);
    } finally {
      setRootFolderSaving(false);
    }
  }

  async function handleRelocateWithChange(target: { id: string; name: string; root_folder_path: string; }, oldRoot: string) {
    setMoveDialog(null);
    setRootFolderPath(target.root_folder_path);
    setRootFolderSaving(true);
    setRelocating(true);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootFolderPath: target.root_folder_path }),
      });
      if (!res.ok) throw new Error("Failed to update root folder");
      const relocate = await fetch(`/api/shows/${show.id}/relocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newRootPath: target.root_folder_path }),
      });
      if (!relocate.ok) throw new Error("Failed to move files");
      const data = await relocate.json();
      flashStatus(`Moved ${data.moved} file${data.moved !== 1 ? "s" : ""} to "${target.name}"${data.failed > 0 ? `. ${data.failed} failed.` : "."}`);
    } catch {
      setRootFolderPath(oldRoot);
      flashStatus("Failed to update root folder.", false);
    } finally {
      setRootFolderSaving(false);
      setRelocating(false);
    }
  }

  async function handleOrganize() {
    setOrganizing(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/organize-preview`);
      if (!res.ok) throw new Error("Failed to load organize preview");
      const data = await res.json();
      setOrganizePreview({
        namingPattern: data.namingPattern ?? "",
        items: data.items ?? [],
        wouldChange: data.wouldChange ?? false,
      });
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to load organize preview.", false);
    } finally {
      setOrganizing(false);
    }
  }

  async function handleOrganizeApply() {
    if (!organizePreview) return;
    setOrganizeApplying(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/organize`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to organize files");
      }
      const data = await res.json();
      const parts: string[] = [];
      if (data.moved > 0) parts.push(`Moved ${data.moved} file${data.moved !== 1 ? "s" : ""} into the show folder`);
      if (data.skipped > 0) parts.push(`${data.skipped} already correct`);
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      flashStatus(parts.length > 0 ? parts.join(", ") + "." : "No files to move.");
      setOrganizePreview(null);
      if (data.moved > 0) loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to organize files.", false);
    } finally {
      setOrganizeApplying(false);
    }
  }

  async function handleRenameFolderPreview() {
    setRenamingFolder(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename-preview`);
      if (!res.ok) throw new Error("Failed to load rename preview");
      const data = await res.json();
      setRenamePreview({
        currentFolderPath: data.currentFolderPath,
        currentFolderName: data.currentFolderName,
        sanitizedTitle: data.sanitizedTitle,
        targetFolderPath: data.targetFolderPath,
        wouldChange: data.wouldChange,
        episodesAffected: (data.episodeImpact ?? []).filter((e: any) => e.wouldUpdate).length,
      });
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to load rename preview.", false);
    } finally {
      setRenamingFolder(false);
    }
  }

  async function handleRenameFolderApply() {
    if (!renamePreview) return;
    setRenamingFolder(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename-apply`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Rename failed");
      flashStatus(data.message ?? `Renamed folder to "${data.to}". ${data.episodesUpdated} episode path${data.episodesUpdated !== 1 ? "s" : ""} updated.`);
      setRenamePreview(null);
      // The show's root folder (library root) did not change — only the show's
      // own folder underneath it was renamed, so nothing to refresh here.
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to rename folder.", false);
    } finally {
      setRenamingFolder(false);
    }
  }

  async function handleRenameSeries() {
    const title = renameSeriesTitle.trim();
    if (!title) return;
    setRenamingSeries(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Rename failed");
      setRenameSeriesOpen(false);
      flashStatus(
        `Renamed to "${data.to}".` +
        (data.folderRenamed ? ` Folder moved (${data.episodesUpdated} episode path${data.episodesUpdated !== 1 ? "s" : ""} updated).` : "") +
        (data.folderError ? ` ${data.folderError}.` : ""),
        !data.folderError,
      );
      // Title + folder changed; the show list needs a refresh so the new
      // title/poster path is picked up.
      if (onToggleExpand) onToggleExpand();
      window.dispatchEvent(new CustomEvent("showflow-refresh-shows", { detail: { showId: show.id, title: data.to } }));
      loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to rename series.", false);
    } finally {
      setRenamingSeries(false);
    }
  }

  async function autoGrabEpisode(episode: EpisodeData) {
    setGrabTarget(`ep:${episode.season}:${episode.episode}`);
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/grab`,
        { method: "POST" },
      );
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  async function autoGrabSeason(season: number) {
    setGrabTarget(`season:${season}`);
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${season}/grab`, { method: "POST" });
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadAllEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  async function toggleSeasonTracked(season: number, tracked: boolean) {
    updateEpisodeBucket(season, (eps) => eps.map((e) => ({ ...e, tracked })));
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${season}/tracked`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracked }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      loadAllEpisodes();
    }
  }

  function toggleColumn(id: string) {
    setColumnConfig(prev => {
      const next = prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c);
      saveColumns(next);
      return next;
    });
  }

  async function handleScanDir() {
    flashStatus("Scanning...");
    try {
      const res = await fetch(`/api/shows/${show.id}/scan`, { method: "POST" });
      if (!res.ok) throw new Error("Scan failed");
      loadAllEpisodes();
      flashStatus("Scan complete.");
    } catch (err) {
      flashStatus("Scan failed.", false);
    }
  }

  async function removeShow() {
    if (!confirm(`Are you sure you want to remove ${show.title} from your library?`)) return;
    try {
      const res = await fetch(`/api/shows/${show.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove show");
      onBack();
    } catch (err) {
      alert(`Error removing show: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-y-auto relative">
      {/* Backdrop background */}
      <div className={`pointer-events-none ${modal ? 'absolute' : 'fixed'} inset-0 z-0 overflow-hidden`}>
        <img
          src={`/api/shows/${show.id}/images/backdrop`}
          alt=""
          aria-hidden
          className="size-full object-cover opacity-[0.18] scale-110"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(circle at 26% 3%, color-mix(in srgb, var(--signal) 20%, transparent), transparent 40%),
            radial-gradient(circle at 88% 83%, rgba(103,78,124,.14), transparent 35%),
            linear-gradient(to bottom, rgba(13,16,21,.3) 0%, rgba(13,16,21,.92) 60%, rgba(13,16,21,1) 100%)
          `
        }} />
      </div>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 md:px-6 py-2 border-b border-white/5 shrink-0"
        style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", background: "rgba(13,16,21,.75)" }}>
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5 transition-colors">
          <ChevronLeft className="size-4" />
          Back
        </button>
        <span className="text-white/20 text-xs">/</span>
        <span className="text-foreground text-sm font-medium truncate">{show.title}</span>

        {status && (
          <span className={`ml-3 text-xs truncate ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
            {status.text}
          </span>
        )}

        {/* Episode availability + file-state filter live in the top bar so
            the list below gets the full height. Compact pills keep it slim. */}
        {overallTotal > 0 && (
          <div className="hidden md:flex items-center gap-2 ml-3 pl-3 border-l border-white/10 shrink-0">
            <span className="font-mono text-xs whitespace-nowrap" title={`${overallAvailable} of ${overallTotal} episodes available`}>
              <span className="text-signal">{overallAvailable}</span>
              <span className="text-muted-foreground">/{overallTotal}</span>
            </span>
            <div className="w-16 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full bg-signal transition-all duration-300"
                style={{ width: `${(overallAvailable / overallTotal) * 100}%` }}
              />
            </div>
            <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-full p-0.5 border border-white/5">
              {(["all", "available", "missing"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-all ${
                    filter === f
                      ? "bg-signal/15 text-signal font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2.5">
          <button onClick={handleScanDir} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors flex items-center gap-1">
            <FolderSearch className="size-3.5" />
            <span className="hidden sm:inline">Scan</span>
          </button>

          {/* Options menu: config, organize and danger actions with
              descriptions — one shared menu for desktop + mobile. */}
          <div className="relative" ref={optionsMenuRef}>
            <button
              onClick={() => setOptionsOpen(v => !v)}
              className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors flex items-center gap-1"
              aria-label="Show options"
              aria-expanded={optionsOpen}
            >
              <MoreHorizontal className="size-4" />
              <span className="hidden sm:inline">Options</span>
            </button>
            {optionsOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-72 rounded-lg border border-white/10 bg-[#15181f] shadow-xl p-2 space-y-0.5"
                style={{ backdropFilter: "blur(16px)" }}>
                <div className="px-2 pt-1 pb-0.5 font-mono text-caption uppercase tracking-wider text-muted-foreground/60">Configure</div>
                <button onClick={() => { setManageSourcesOpen(true); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85">Sources</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Indexers, download clients and import paths for this show</div>
                </button>
                <button onClick={() => { setMappingOpen(true); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85 flex items-center gap-2">
                    <GitCompareArrows className="size-4 text-signal" />
                    Episode Mapping
                    <span className={`ml-auto size-1.5 rounded-full ${mappingHealth === 'ok' ? 'bg-emerald-400' : mappingHealth === 'conflicts' ? 'bg-amber-400' : mappingHealth === 'error' ? 'bg-red-400' : 'bg-slate-500'}`} />
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Scene ↔ provider numbering overrides for anime and specials</div>
                </button>
                {profiles.length > 0 && (
                  <div className="px-2 py-1.5">
                    <div className="text-sm text-foreground/85 mb-0.5">Quality Profile</div>
                    <div className="text-xs text-muted-foreground mb-1.5">Which quality formats to accept for this show</div>
                    <Select value={profile} onValueChange={handleProfileChange}>
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {profiles.map(p => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="px-2 py-1.5">
                  <div className="text-sm text-foreground/85 mb-0.5">Series Type</div>
                  <div className="text-xs text-muted-foreground mb-1.5">Standard or anime routing, plus the matching root folder</div>
                  <Select value={seriesType} onValueChange={handleSeriesTypeChange}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="anime">Anime</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <hr className="border-white/5 my-1" />
                <div className="px-2 pt-1 pb-0.5 font-mono text-caption uppercase tracking-wider text-muted-foreground/60">Organize</div>
                <button onClick={() => { handleOrganize(); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85 flex items-center gap-2">
                    {organizing ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4 text-signal" />}
                    Organize Files
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Rename episode files to your naming pattern</div>
                </button>
                <button onClick={() => { handleRenameFolderPreview(); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85 flex items-center gap-2">
                    {renamingFolder ? <Loader2Icon className="size-4 animate-spin" /> : <FolderSearch className="size-4 text-signal" />}
                    Rename Folder
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Match the show folder to the sanitized title</div>
                </button>
                <button onClick={() => { setRenameSeriesTitle(show.title); setRenameSeriesOpen(true); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85 flex items-center gap-2">
                    <PencilIcon className="size-4 text-signal" />
                    Rename Series
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Change the series title itself</div>
                </button>
                <button onClick={() => { setDuplicatesOpen(true); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] transition-colors">
                  <div className="text-sm text-foreground/85 flex items-center gap-2">
                    <FolderArchive className="size-4 text-signal" />
                    Dedupe
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">Find overlapping and duplicate files</div>
                </button>
                <hr className="border-white/5 my-1" />
                <button onClick={() => { removeShow(); setOptionsOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-red-400/10 transition-colors">
                  <div className="text-sm text-red-400">Remove</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Remove this show from your library</div>
                </button>
              </div>
            )}
          </div>

          {/* Column visibility lives up here now that the episode toolbar
              row is gone; the dropdown anchors to this wrapper. */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowColumnMenu(v => !v)}
              className="text-muted-foreground hover:text-foreground transition-colors flex items-center"
              aria-label="Column settings"
            >
              <Columns2 className="size-4" />
            </button>

            {showColumnMenu && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-44 rounded-lg border border-white/10 bg-[#15181f] shadow-xl p-1.5"
                style={{ backdropFilter: "blur(16px)" }}>
                <div className="px-2 py-1 text-caption font-mono uppercase tracking-wider text-muted-foreground/60">
                  Columns
                </div>
                {columnConfig.map(col => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] cursor-pointer text-sm text-foreground/80"
                  >
                    <input
                      type="checkbox"
                      checked={col.visible}
                      onChange={() => toggleColumn(col.id)}
                      className="size-3.5 rounded border-white/20 bg-white/5 accent-signal"
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          {onToggleExpand && (
            <button onClick={onToggleExpand} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors" title={expanded ? "Minimize" : "Expand"}>
              {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          )}
          {modal && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors">
              <XIcon className="size-4" />
            </button>
          )}
        </div>
      </header>

      {/* Hero Banner */}
      <section className="group relative z-10 w-full aspect-[21/7] max-h-[360px] min-h-[210px] overflow-hidden shrink-0">
        <img
          src={`/api/shows/${show.id}/images/backdrop?index=${backdropIndex}`}
          alt=""
          aria-hidden
          className="size-full object-cover object-center"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        {backdropOptions.length > 1 && (
          <>
            <button
              onClick={() => cycleBackdrop(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-20 rounded-full bg-black/50 p-1.5 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 hover:text-white"
              aria-label="Previous backdrop"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              onClick={() => cycleBackdrop(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-20 rounded-full bg-black/50 p-1.5 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70 hover:text-white"
              aria-label="Next backdrop"
            >
              <ChevronRight className="size-4" />
            </button>
            <span className="absolute bottom-2 right-3 z-20 rounded-full bg-black/50 px-2 py-0.5 font-mono text-[10px] text-white/70 opacity-0 group-hover:opacity-100 transition-opacity">
              {backdropIndex + 1}/{backdropOptions.length}
            </span>
          </>
        )}
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(circle at 26% 3%, color-mix(in srgb, var(--signal) 25%, transparent), transparent 40%),
            linear-gradient(to bottom, rgba(13,16,21,.15) 0%, rgba(13,16,21,.5) 40%, rgba(13,16,21,.95) 100%)
          `
        }} />
        <div className="absolute bottom-0 left-0 right-0 flex items-end gap-4 md:gap-6 px-4 md:px-8 pb-4 md:pb-8">
          <div className="shrink-0 w-[110px] md:w-[140px] rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
            <img
              src={`/api/shows/${show.id}/images/poster`}
              alt={show.title}
              className="w-full aspect-[2/3] object-cover"
            />
          </div>
          <div className="min-w-0 flex-1 pb-1.5">
            <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-wide text-white leading-tight">
              {show.title}
            </h1>
            <div className="flex items-center gap-2.5 mt-2 text-xs font-mono text-muted-foreground">
              <span className="uppercase tracking-wider">{show.providerType}</span>
              <span className="text-white/15">·</span>
              {seasons && (
                <>
                  <span className="text-white/15">·</span>
                  <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
                  <span className="text-white/15">·</span>
                  <span>{seasons.reduce((a, s) => a + s.episodeCount, 0)} episodes</span>
                </>
              )}
              {releaseDelayMinutes != null && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="inline-flex items-center gap-1 text-accent-amber/90" title="Learned release delay: expected minutes after air time that releases typically appear for this show">
                    <Clock className="size-3" />
                    releases ~{formatDelayMinutes(releaseDelayMinutes)} after air
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Content */}
      <div className="relative z-10 flex-1 px-4 md:px-8 pt-4 md:pt-6 pb-4 md:pb-8 flex flex-col min-h-0">
        {seasons === null ? (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <div className="size-4 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
            Loading seasons...
          </div>
        ) : seasons.length === 0 ? (
          <GlassPanel className="p-10 text-center text-sm text-muted-foreground">
            No episodes synced yet for this show.
          </GlassPanel>
        ) : (
          <div className="flex flex-col min-h-0 gap-4">
            {/* Mobile only: the availability summary + filter live in the
                top bar on md+ screens, so this slim row covers small ones. */}
            {overallTotal > 0 && (
              <div className="flex md:hidden items-center gap-2 shrink-0">
                <span className="font-mono text-xs whitespace-nowrap">
                  <span className="text-signal">{overallAvailable}</span>
                  <span className="text-muted-foreground">/{overallTotal} available</span>
                </span>
                <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-full p-0.5 border border-white/5 ml-auto">
                  {(["all", "available", "missing"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-all ${
                        filter === f
                          ? "bg-signal/15 text-signal font-semibold"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Unified episode list: all seasons, latest first, collapsible */}
            <GlassPanel className="flex-1 overflow-hidden min-h-0 flex flex-col">
              {loadingEpisodes || !episodesLoaded ? (
                <div className="flex items-center gap-2 p-10 text-sm text-muted-foreground">
                  <div className="size-4 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
                  Loading episodes...
                </div>
              ) : sections.every((s) => s.episodes.length === 0) ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  {filter === "all" ? "No episodes loaded." : filter === "available" ? "No available episodes." : "No missing episodes."}
                </div>
              ) : (
                <div className="overflow-y-auto">
                  {sections.map(({ season, all, episodes: eps }) => {
                    const n = season.seasonNumber;
                    const expanded = forceExpand || !collapsed[n];
                    const avail = all.filter((e) => !!e.filePath).length;
                    const seasonTracked = all.length > 0 && all.every((e) => e.tracked);
                    const grabbingSeason = grabTarget === `season:${n}`;
                    return (
                      <div key={n} className="border-b border-white/[0.04] last:border-0">
                        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => setCollapsed((prev) => ({ ...prev, [n]: !prev[n] }))}
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                            aria-expanded={expanded}
                          >
                            <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
                            <span className="font-display text-sm font-semibold tracking-wide text-white/85 shrink-0">
                              {seasonLabel(n)}
                            </span>
                            <span className="font-mono text-xs shrink-0">
                              <span className="text-signal">{avail}</span>
                              <span className="text-muted-foreground">/{all.length}</span>
                            </span>
                            <span className="hidden sm:block w-24 h-1 rounded-full bg-white/5 overflow-hidden shrink-0">
                              <span
                                className="block h-full rounded-full bg-signal/70"
                                style={{ width: all.length ? `${(avail / all.length) * 100}%` : "0%" }}
                              />
                            </span>
                          </button>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {all.length > 0 && (
                              <button
                                type="button"
                                onClick={() => toggleSeasonTracked(n, !seasonTracked)}
                                title={seasonTracked ? `Stop monitoring all ${seasonLabel(n).toLowerCase()} episodes` : `Monitor all ${seasonLabel(n).toLowerCase()} episodes for new releases`}
                                className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-2.5 py-1 font-mono text-caption uppercase tracking-wider transition-colors"
                              >
                                <Check className="size-3" /> {seasonTracked ? "Unmonitor" : "Monitor"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setSearchTarget({ season: n })}
                              title={`Browse and manually pick a ${seasonLabel(n).toLowerCase()} release`}
                              className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-2.5 py-1 font-mono text-caption uppercase tracking-wider transition-colors"
                            >
                              <SearchIcon className="size-3" /> Browse
                            </button>
                            <button
                              type="button"
                              onClick={() => autoGrabSeason(n)}
                              disabled={grabbingSeason}
                              title={`Automatically search and download the best matching ${seasonLabel(n).toLowerCase()} release`}
                              className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-2.5 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-50"
                            >
                              {grabbingSeason ? (
                                <Loader2Icon className="size-3 animate-spin" />
                              ) : (
                                <DownloadIcon className="size-3" />
                              )}
                              Auto
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          eps.length === 0 ? (
                            <p className="px-4 pb-3 pl-11 text-xs text-muted-foreground">
                              {filter === "available" ? "No available episodes in this season." : "No missing episodes in this season."}
                            </p>
                          ) : (
                            <div className="divide-y divide-white/[0.04]">
                              {eps.map((ep) => (
                                <EpisodeRow
                                  key={`${ep.season}-${ep.episode}`}
                                  episode={ep}
                                  columns={columnConfig}
                                  grabbing={grabTarget === `ep:${ep.season}:${ep.episode}`}
                                  onToggleTracked={(tracked) => toggleTracked(ep, tracked)}
                                  onChangeSearchMode={(mode) => handleSearchMode(ep, mode)}
                                  onAutoGrab={() => autoGrabEpisode(ep)}
                                  onOpenSearch={() => setSearchTarget({ season: ep.season, episode: ep.episode })}
                                />
                              ))}
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </GlassPanel>
          </div>
        )}
      </div>

      {searchTarget && (
        <ReleaseSearchDialog
          open={searchTarget !== null}
          onOpenChange={(open) => { if (!open) setSearchTarget(null); }}
          showId={show.id}
          showTitle={show.title}
          season={searchTarget.season}
          episode={searchTarget.episode}
          onGrabbed={(message, success) => {
            flashStatus(message, success);
            loadAllEpisodes();
          }}
          autoCloseOnSuccess
        />
      )}

      <ManageSourcesDialog
        showId={show.id}
        showTitle={show.title}
        open={manageSourcesOpen}
        onOpenChange={setManageSourcesOpen}
        onSourcesChanged={() => {
          // Refresh the whole list after source changes (new episodes might appear)
          loadAllEpisodes();
        }}
      />

      {organizePreview && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
            style={{ backdropFilter: "blur(16px)" }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-semibold text-white/90">Organize episodes?</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Files will be moved into the show's proper folder structure with your naming pattern. All paths relative to the show's library root.
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-white/60">
                {organizePreview.items.filter(i => i.action === 'move').length} move{organizePreview.items.filter(i => i.action === 'move').length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">Naming pattern</div>
              <code className="text-signal text-xs break-all">{organizePreview.namingPattern}</code>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-white/10 bg-black/20 divide-y divide-white/[0.04]">
              {organizePreview.items.length === 0 && (
                <p className="px-3 py-3 text-xs text-muted-foreground">No episode files on disk to organize.</p>
              )}
              {organizePreview.items.map((item, idx) => {
                const move = item.action === 'move';
                return (
                  <div key={idx} className="px-3 py-2.5 text-xs space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-muted-foreground shrink-0">S{item.season}E{item.episode}</span>
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${move ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                        {move ? "move" : "correct"}
                      </span>
                    </div>
                    {move && (
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        <div className="space-y-0.5">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">From</div>
                          <div className="text-muted-foreground/70 break-all font-mono text-[11px] leading-relaxed">{item.currentPath}</div>
                        </div>
                        <div className="space-y-0.5">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60">To</div>
                          <div className="text-signal break-all font-mono text-[11px] leading-relaxed">{item.targetPath}</div>
                        </div>
                      </div>
                    )}
                    {!move && (
                      <div className="text-muted-foreground/60 break-all font-mono text-[11px] leading-relaxed">{item.currentPath}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {!organizePreview.wouldChange ? (
              <p className="text-xs text-muted-foreground">
                All files already sit at their target paths — nothing to do.
              </p>
            ) : (
              <p className="text-[11px] text-amber-400/80 border border-amber-500/30 rounded px-2 py-1.5 bg-amber-500/5">
                Plex/Jellyfin libraries will need a scan after the move.
              </p>
            )}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOrganizePreview(null)}
                className="flex-1 rounded-md border border-white/10 text-muted-foreground text-sm font-medium py-2 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={organizeApplying || !organizePreview.wouldChange}
                onClick={handleOrganizeApply}
                className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
              >
                {organizeApplying ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2Icon className="size-3.5 animate-spin" /> Organizing...
                  </span>
                ) : (
                  "Move Files"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {renamePreview && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
            style={{ backdropFilter: "blur(16px)" }}>
            <h3 className="font-display text-lg font-semibold text-white/90">Rename show folder?</h3>
            <p className="text-xs text-muted-foreground -mt-2">
              The folder on disk will be renamed to match the show's current title. Episode file paths are updated automatically.
            </p>

            <div className="space-y-2 text-xs">
              <div>
                <div className="flex items-center gap-2">
                  <span className="uppercase tracking-wider font-mono text-muted-foreground text-[10px] w-11 shrink-0">From</span>
                  <code className="text-foreground/85 break-all">{renamePreview.currentFolderName}</code>
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 break-all pl-[52px]">
                  {renamePreview.currentFolderPath}
                </p>
              </div>
              <div className="text-muted-foreground/40 pl-[52px] font-mono text-[10px]">↓ rename to</div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="uppercase tracking-wider font-mono text-signal text-[10px] w-11 shrink-0">To</span>
                  <code className="text-signal break-all">{renamePreview.sanitizedTitle}</code>
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 break-all pl-[52px]">
                  {renamePreview.targetFolderPath}
                </p>
              </div>
            </div>

            {!renamePreview.wouldChange ? (
              <p className="text-xs text-muted-foreground">
                Folder already has the correct name — nothing to do.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {renamePreview.episodesAffected > 0
                    ? `${renamePreview.episodesAffected} episode${renamePreview.episodesAffected !== 1 ? "s" : ""} inside this folder will${renamePreview.episodesAffected !== 1 ? " " : ""}have its file path updated automatically.`
                    : "No episode paths need updating."}
                </p>
                <p className="text-[11px] text-amber-400/80 border border-amber-500/30 rounded px-2 py-1.5 bg-amber-500/5">
                  Plex/Jellyfin libraries that point at the old folder path will need a library refresh after the rename.
                </p>
              </>
            )}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRenamePreview(null)}
                className="flex-1 rounded-md border border-white/10 text-muted-foreground text-sm font-medium py-2 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={renamingFolder || !renamePreview.wouldChange}
                onClick={handleRenameFolderApply}
                className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
              >
                {renamingFolder ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2Icon className="size-3.5 animate-spin" /> Renaming...
                  </span>
                ) : (
                  "Rename Folder"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameSeriesOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
            style={{ backdropFilter: "blur(16px)" }}>
            <h3 className="font-display text-lg font-semibold text-white/90">Rename series</h3>
            <p className="text-xs text-muted-foreground -mt-2">
              Changes the series title everywhere: the library display name, episode naming, and the on-disk
              folder (which is renamed to match the new title, with episode paths updated). The old title stays
              registered as an alias so files already on disk keep matching.
            </p>
            <label className="block space-y-1.5">
              <span className="text-caption font-mono uppercase tracking-wider text-muted-foreground/70">Title</span>
              <input
                value={renameSeriesTitle}
                onChange={(e) => setRenameSeriesTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && renameSeriesTitle.trim()) handleRenameSeries(); }}
                autoFocus
                className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground outline-none focus:border-signal/50 focus:ring-1 focus:ring-signal/30"
              />
            </label>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRenameSeriesOpen(false)}
                className="flex-1 rounded-md border border-white/10 text-muted-foreground text-sm font-medium py-2 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={renamingSeries || !renameSeriesTitle.trim()}
                onClick={handleRenameSeries}
                className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
              >
                {renamingSeries ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2Icon className="size-3.5 animate-spin" /> Renaming...
                  </span>
                ) : (
                  "Rename Series"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <EpisodeMappingDialog
        showId={show.id}
        showTitle={show.title}
        open={mappingOpen}
        onOpenChange={setMappingOpen}
        onChanged={() => {
          fetch(`/api/shows/${show.id}`).then(r => r.json()).then(data => {
            setMappingHealth(data.config?.episodeMapping?.health ?? 'none');
          }).catch(() => {});
        }}
      />

      <EpisodeDuplicatesDialog
        showId={show.id}
        open={duplicatesOpen}
        onOpenChange={setDuplicatesOpen}
        onResolved={() => loadAllEpisodes()}
      />

      {moveDialog && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
            style={{ backdropFilter: "blur(16px)" }}>
            <h3 className="font-display text-lg font-semibold text-white/90">Move existing files?</h3>
            <p className="text-sm text-muted-foreground">
              Episodes are currently stored under <code className="text-foreground/80">{moveDialog.oldRoot}</code>.
              Moving to <code className="text-foreground/80">{moveDialog.newRoot}</code> will physically relocate them.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={relocating}
                onClick={() => handleRelocateWithChange(
                  folderProfiles.find(fp => fp.id === moveDialog.profileId)!,
                  moveDialog.oldRoot,
                )}
                className="flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
              >
                {relocating ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2Icon className="size-3.5 animate-spin" /> Moving...
                  </span>
                ) : (
                  "Move files"
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = folderProfiles.find(fp => fp.id === moveDialog.profileId);
                  if (target) executeRootFolderChange(target);
                  setMoveDialog(null);
                }}
                className="flex-1 rounded-md border border-white/10 hover:bg-white/[0.04] text-sm text-muted-foreground hover:text-foreground py-2 transition-colors"
              >
                Change folder only
              </button>
              <button
                type="button"
                onClick={() => setMoveDialog(null)}
                className="text-muted-foreground hover:text-foreground text-sm py-2 px-3 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { ShowDetail };
