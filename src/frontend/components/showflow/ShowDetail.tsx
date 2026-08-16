import { Check, ChevronLeft, Columns2, DownloadIcon, FolderSearch, GitCompareArrows, Loader2Icon, Maximize2, Minimize2, MoreHorizontal, RefreshCwIcon, SearchIcon, XIcon, Clock } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { EpisodeRow, type EpisodeData, type ColumnDef } from "@frontend/components/showflow/EpisodeRow";
import { ManageSourcesDialog } from "@frontend/components/showflow/ManageSourcesDialog";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { EpisodeMappingDialog } from "@frontend/components/showflow/EpisodeMappingDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";
import { formatDelayMinutes } from "@frontend/lib/airtime";


interface SeasonStat {
  seasonNumber: number;
  episodeCount: number;
  trackedCount: number;
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
// the right button without a big lookup table. 'season' covers the
// season-level auto-grab; a number covers that episode's auto-grab.
type GrabTarget = 'season' | number | null;

// What the ReleaseSearchDialog is currently showing - undefined episode
// means a season-level (pack) search.
interface SearchTarget {
  season: number;
  episode?: number;
}

function ShowDetail({ show, onBack, modal = false, onToggleExpand, expanded }: { show: ShowSummary; onBack: () => void; modal?: boolean; onToggleExpand?: () => void; expanded?: boolean }) {
  const [seasons, setSeasons] = React.useState<SeasonStat[] | null>(null);
  const [activeSeason, setActiveSeason] = React.useState<number | null>(null);
  const [episodes, setEpisodes] = React.useState<EpisodeData[] | null>(null);
  const [loadingEpisodes, setLoadingEpisodes] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "available" | "missing">("all");
  const [columnConfig, setColumnConfig] = React.useState<ColumnDef[]>(loadColumns);
  const [showColumnMenu, setShowColumnMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = React.useState(false);
  const headerMenuRef = React.useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [profile, setProfile] = React.useState<string>(show.profile || "standard");

  const [folderProfiles, setFolderProfiles] = React.useState<{ id: string; name: string; root_folder_path: string }[]>([]);
  const [rootFolderPath, setRootFolderPath] = React.useState<string | null>(null);
  const [rootFolderSaving, setRootFolderSaving] = React.useState(false);
  const [seriesType, setSeriesType] = React.useState<string>("standard");
  const [releaseDelayMinutes, setReleaseDelayMinutes] = React.useState<number | null>(null);

  const [manageSourcesOpen, setManageSourcesOpen] = React.useState(false);
  const [searchTarget, setSearchTarget] = React.useState<SearchTarget | null>(null);
  const [grabTarget, setGrabTarget] = React.useState<GrabTarget>(null);
  const [relocating, setRelocating] = React.useState(false);
  const [organizing, setOrganizing] = React.useState(false);
  const [renamingFolder, setRenamingFolder] = React.useState(false);
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
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenuOpen(false);
      }
    }
    if (showColumnMenu || headerMenuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showColumnMenu, headerMenuOpen]);

  React.useEffect(() => {
    setSeasons(null);
    setActiveSeason(null);
    setEpisodes(null);
    fetch(`/api/shows/${show.id}/seasons`)
      .then((r) => r.json())
      .then((data: SeasonStat[]) => {
        setSeasons(data);
        const first = data[0];
        if (first) setActiveSeason(first.seasonNumber);
      });
  }, [show.id]);

  function loadEpisodes() {
    if (activeSeason === null) return;
    setLoadingEpisodes(true);
    fetch(`/api/shows/${show.id}/seasons/${activeSeason}/episodes`)
      .then((r) => r.json())
      .then((data: EpisodeData[]) => setEpisodes(data))
      .finally(() => setLoadingEpisodes(false));
  }

  React.useEffect(loadEpisodes, [show.id, activeSeason]);

  const filteredEpisodes = React.useMemo(() => {
    if (!episodes) return null;
    if (filter === "all") return episodes;
    const hasFile = (ep: EpisodeData) => !!ep.filePath;
    return episodes.filter((ep) => (filter === "available" ? hasFile(ep) : !hasFile(ep)));
  }, [episodes, filter]);

  const availableCount = episodes?.filter((e) => !!e.filePath).length ?? 0;
  const totalCount = episodes?.length ?? 0;
  const allTracked = episodes && episodes.length > 0 && episodes.every((e) => e.tracked);

  async function toggleTracked(episode: EpisodeData, tracked: boolean) {
    setEpisodes((prev) => prev?.map((e) => (e.episode === episode.episode ? { ...e, tracked } : e)) ?? prev);
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/tracked`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracked }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      setEpisodes((prev) => prev?.map((e) => (e.episode === episode.episode ? { ...e, tracked: !tracked } : e)) ?? prev);
    }
  }

  async function handleSearchMode(episode: EpisodeData, mode: 'auto' | 'interactive') {
    setEpisodes((prev) => prev?.map((e) => (e.episode === episode.episode ? { ...e, searchMode: mode } : e)) ?? prev);
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/search`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
      );
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      setEpisodes((prev) => prev?.map((e) => (e.episode === episode.episode ? { ...e, searchMode: episode.searchMode === 'auto' ? 'interactive' : 'auto' } : e)) ?? prev);
    }
  }

  async function handleProfileChange(next: string) {
    const prev = profile;
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
      const res = await fetch(`/api/shows/${show.id}/organize`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to organize files");
      const data = await res.json();
      const parts: string[] = [];
      if (data.renamed > 0) parts.push(`Renamed ${data.renamed} file${data.renamed !== 1 ? "s" : ""}`);
      if (data.skipped > 0) parts.push(`${data.skipped} already correct`);
      flashStatus(parts.length > 0 ? parts.join(", ") + "." : "No files to rename.");
      if (data.renamed > 0) loadEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to organize files.", false);
    } finally {
      setOrganizing(false);
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

  async function autoGrabEpisode(episode: EpisodeData) {
    setGrabTarget(episode.episode);
    try {
      const res = await fetch(
        `/api/shows/${show.id}/seasons/${episode.season}/episodes/${episode.episode}/grab`,
        { method: "POST" },
      );
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  async function autoGrabSeason() {
    if (activeSeason === null) return;
    setGrabTarget('season');
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${activeSeason}/grab`, { method: "POST" });
      const data = await res.json();
      flashStatus(data.message ?? (data.success ? "Grabbed." : "Grab failed."), !!data.success);
      if (data.success) loadEpisodes();
    } catch (err: any) {
      flashStatus(err.message ?? "Grab failed.", false);
    } finally {
      setGrabTarget(null);
    }
  }

  async function toggleSeasonTracked(tracked: boolean) {
    if (activeSeason === null) return;
    setEpisodes((prev) => prev?.map((e) => ({ ...e, tracked })) ?? prev);
    setSeasons((prev) => prev?.map((s) =>
      s.seasonNumber === activeSeason ? { ...s, trackedCount: tracked ? s.episodeCount : 0 } : s
    ) ?? prev);
    try {
      const res = await fetch(`/api/shows/${show.id}/seasons/${activeSeason}/tracked`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracked }),
      });
      if (!res.ok) throw new Error("Failed to update");
    } catch {
      loadEpisodes();
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
      loadEpisodes();
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

        <div className="ml-auto items-center gap-3 hidden md:flex">
          <button onClick={() => setManageSourcesOpen(true)} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors">
            Sources
          </button>
          <button onClick={() => setMappingOpen(true)} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors flex items-center gap-1.5">
            <GitCompareArrows className="size-3.5" />
            Mapping
            <span className={`size-1.5 rounded-full ${mappingHealth === 'ok' ? 'bg-emerald-400' : mappingHealth === 'conflicts' ? 'bg-amber-400' : mappingHealth === 'error' ? 'bg-red-400' : 'bg-slate-500'}`} />
          </button>
          {profiles.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground/60">Profile</span>
              <Select value={profile} onValueChange={handleProfileChange}>
                <SelectTrigger size="sm" className="w-32">
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
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground/60">Type</span>
              <Select value={seriesType} onValueChange={v => {
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
              }}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="anime">Anime</SelectItem>
                </SelectContent>
              </Select>
            </div>
          <button onClick={handleScanDir} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors flex items-center gap-1">
            <FolderSearch className="size-3.5" />
            Scan
          </button>
          <button onClick={removeShow} className="text-muted-foreground hover:text-red-400 text-sub font-mono tracking-wider uppercase transition-colors">
            Remove
          </button>
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

        {/* Mobile header menu */}
        <div className="relative md:hidden ml-auto" ref={headerMenuRef}>
          <button
            onClick={() => setHeaderMenuOpen(v => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Show options"
          >
            <MoreHorizontal className="size-5" />
          </button>
          {headerMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-30 w-52 rounded-lg border border-white/10 bg-[#15181f] shadow-xl p-2 space-y-1"
              style={{ backdropFilter: "blur(16px)" }}>
              <button onClick={() => { setManageSourcesOpen(true); setHeaderMenuOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] text-sm text-foreground/80">
                Sources
              </button>
              <button onClick={() => { setMappingOpen(true); setHeaderMenuOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.04] text-sm text-foreground/80 flex items-center gap-2">
                <GitCompareArrows className="size-4 text-signal" />
                Episode Mapping
                <span className={`ml-auto size-1.5 rounded-full ${mappingHealth === 'ok' ? 'bg-emerald-400' : mappingHealth === 'conflicts' ? 'bg-amber-400' : mappingHealth === 'error' ? 'bg-red-400' : 'bg-slate-500'}`} />
              </button>
              {profiles.length > 0 && (
                <div className="px-2 py-1.5">
                  <div className="font-mono text-caption uppercase tracking-wider text-muted-foreground/60 mb-1">Profile</div>
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
                <div className="font-mono text-caption uppercase tracking-wider text-muted-foreground/60 mb-1">Type</div>
                <Select value={seriesType} onValueChange={v => {
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
                  setHeaderMenuOpen(false);
                }}>
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
              <button onClick={() => { removeShow(); setHeaderMenuOpen(false); }} className="w-full text-left px-2 py-2 rounded-md hover:bg-red-400/10 text-sm text-red-400">
                Remove
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Hero Banner */}
      <section className="relative z-10 w-full aspect-[21/8] max-h-[300px] min-h-[180px] overflow-hidden shrink-0">
        <img
          src={`/api/shows/${show.id}/images/backdrop`}
          alt=""
          aria-hidden
          className="size-full object-cover object-center"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
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
      <div className="relative z-10 flex-1 px-4 md:px-8 pb-4 md:pb-8 flex flex-col min-h-0">
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
            {/* Season pills */}
            <div className="flex items-center gap-2 overflow-x-auto pb-0.5 shrink-0">
              {seasons.map((s) => (
                <button
                  key={s.seasonNumber}
                  onClick={() => { setActiveSeason(s.seasonNumber); setFilter("all"); }}
                  className={`shrink-0 rounded-full px-4 py-1.5 font-mono text-xs transition-all ${
                    activeSeason === s.seasonNumber
                      ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)] font-semibold"
                      : "text-muted-foreground hover:text-foreground bg-white/[0.04] hover:bg-white/[0.07]"
                  }`}
                >
                  {s.seasonNumber === 0 ? "Specials" : `S${String(s.seasonNumber).padStart(2, "0")}`}
                  <span className="ml-1.5 opacity-50">{s.trackedCount}/{s.episodeCount}</span>
                </button>
              ))}
            </div>

            {/* Episode toolbar */}
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <h2 className="font-display text-base font-semibold tracking-wide text-white/80">Episodes</h2>
              <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-full p-0.5 border border-white/5">
                {(["all", "available", "missing"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-full px-3 py-1 font-mono text-caption uppercase tracking-wider transition-all ${
                      filter === f
                        ? "bg-signal/15 text-signal font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Season-level actions */}
              {activeSeason !== null && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {episodes && episodes.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleSeasonTracked(!allTracked)}
                      title={allTracked ? "Stop monitoring all episodes in this season" : "Start monitoring all episodes in this season for new releases"}
                      className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors"
                    >
                      <Check className="size-3" /> {allTracked ? "Unmonitor All" : "Monitor All"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSearchTarget({ season: activeSeason })}
                    title="Browse and manually pick a release"
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors"
                  >
                    <SearchIcon className="size-3" /> Browse
                  </button>
                  <button
                    type="button"
                    onClick={autoGrabSeason}
                    disabled={grabTarget === 'season'}
                    title="Automatically search and download the best matching release"
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    {grabTarget === 'season' ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <DownloadIcon className="size-3" />
                    )}
                    Auto Download
                  </button>
                  <button
                    type="button"
                    onClick={handleOrganize}
                    disabled={organizing}
                    title="Rename all episode files to a consistent naming format"
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    {organizing ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                    Organize
                  </button>
                  <button
                    type="button"
                    onClick={handleRenameFolderPreview}
                    disabled={renamingFolder}
                    title="Preview and apply a folder rename to match the sanitized show title"
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    {renamingFolder ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <FolderSearch className="size-3" />
                    )}
                    Rename Folder
                  </button>
                </div>
              )}

              <div className="ml-auto relative" ref={menuRef}>
                <button
                  onClick={() => setShowColumnMenu(v => !v)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
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
            </div>

            {/* Season progress */}
            <div className="flex items-center gap-3 shrink-0">
              <span className="font-mono text-xs text-muted-foreground">
                Season {activeSeason}
              </span>
              <span className="font-mono text-xs">
                <span className="text-signal">{availableCount}</span>
                <span className="text-muted-foreground">/{totalCount} available</span>
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden max-w-56">
                <div
                  className="h-full rounded-full bg-signal transition-all duration-300"
                  style={{ width: totalCount ? `${(availableCount / totalCount) * 100}%` : "0%" }}
                />
              </div>
            </div>

            {/* Episode list */}
            <GlassPanel className="flex-1 overflow-hidden min-h-0 flex flex-col">
              {loadingEpisodes || filteredEpisodes === null ? (
                <div className="flex items-center gap-2 p-10 text-sm text-muted-foreground">
                  <div className="size-4 rounded-full border border-muted-foreground/40 border-t-transparent animate-spin" />
                  Loading episodes...
                </div>
              ) : filteredEpisodes.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  {filter === "all" ? "No episodes loaded." : filter === "available" ? "No available episodes." : "No missing episodes."}
                </div>
              ) : (
                <div className="divide-y divide-white/[0.04] overflow-y-auto">
                  {filteredEpisodes.map((ep) => (
                    <EpisodeRow
                      key={`${ep.season}-${ep.episode}`}
                      episode={ep}
                      columns={columnConfig}
                      grabbing={grabTarget === ep.episode}
                      onToggleTracked={(tracked) => toggleTracked(ep, tracked)}
                      onChangeSearchMode={(mode) => handleSearchMode(ep, mode)}
                      onAutoGrab={() => autoGrabEpisode(ep)}
                      onOpenSearch={() => setSearchTarget({ season: ep.season, episode: ep.episode })}
                    />
                  ))}
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
            loadEpisodes();
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
          // Refresh seasons after source changes (new episodes might appear)
          fetch(`/api/shows/${show.id}/seasons`)
            .then(r => r.json())
            .then((data: SeasonStat[]) => {
              setSeasons(data);
            });
        }}
      />

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
