import { ChevronLeft, Columns2, DownloadIcon, Loader2Icon, SearchIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { EpisodeRow, type EpisodeData, type ColumnDef } from "@frontend/components/showflow/EpisodeRow";
import { ManageSourcesDialog } from "@frontend/components/showflow/ManageSourcesDialog";
import { ReleaseSearchDialog } from "@frontend/components/showflow/ReleaseSearchDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import type { ShowSummary } from "@frontend/components/showflow/PosterCard";


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

function ShowDetail({ show, onBack }: { show: ShowSummary; onBack: () => void }) {
  const [seasons, setSeasons] = React.useState<SeasonStat[] | null>(null);
  const [activeSeason, setActiveSeason] = React.useState<number | null>(null);
  const [episodes, setEpisodes] = React.useState<EpisodeData[] | null>(null);
  const [loadingEpisodes, setLoadingEpisodes] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "available" | "missing">("all");
  const [columnConfig, setColumnConfig] = React.useState<ColumnDef[]>(loadColumns);
  const [showColumnMenu, setShowColumnMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [profile, setProfile] = React.useState<string>(show.profile || "standard");

  const [manageSourcesOpen, setManageSourcesOpen] = React.useState(false);
  const [searchTarget, setSearchTarget] = React.useState<SearchTarget | null>(null);
  const [grabTarget, setGrabTarget] = React.useState<GrabTarget>(null);

  const [status, setStatus] = React.useState<{ ok: boolean; text: string } | null>(null);
  const statusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashStatus(text: string, ok = true) {
    setStatus({ ok, text });
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 6000);
  }

  React.useEffect(() => {
    fetch("/api/profiles").then(r => r.json()).then(data => setProfiles(Array.isArray(data) ? data : [])).catch(() => setProfiles([]));
  }, []);

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowColumnMenu(false);
      }
    }
    if (showColumnMenu) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showColumnMenu]);

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

  function toggleColumn(id: string) {
    setColumnConfig(prev => {
      const next = prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c);
      saveColumns(next);
      return next;
    });
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
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
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
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 px-6 border-b border-white/5 shrink-0"
        style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", background: "rgba(13,16,21,.75)" }}>
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5 transition-colors">
          <ChevronLeft className="size-4" />
          Library
        </button>
        <span className="text-white/20 text-xs">/</span>
        <span className="text-foreground text-sm font-medium truncate">{show.title}</span>

        {status && (
          <span className={`ml-3 text-xs truncate ${status.ok ? "text-emerald-400" : "text-red-400"}`}>
            {status.text}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setManageSourcesOpen(true)} className="text-muted-foreground hover:text-foreground text-sub font-mono tracking-wider uppercase transition-colors">
            Sources
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
          <button onClick={removeShow} className="text-muted-foreground hover:text-red-400 text-sub font-mono tracking-wider uppercase transition-colors">
            Remove
          </button>
        </div>
      </header>

      {/* Hero Banner */}
      <section className="relative z-10 w-full h-[300px] md:h-[400px] overflow-hidden shrink-0">
        <img
          src={`/api/shows/${show.id}/images/backdrop`}
          alt=""
          aria-hidden
          className="size-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <div className="absolute inset-0" style={{
          background: `
            radial-gradient(circle at 26% 3%, color-mix(in srgb, var(--signal) 25%, transparent), transparent 40%),
            linear-gradient(to bottom, rgba(13,16,21,.15) 0%, rgba(13,16,21,.5) 40%, rgba(13,16,21,.95) 100%)
          `
        }} />
        <div className="absolute bottom-0 left-0 right-0 flex items-end gap-6 px-8 pb-8">
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
              <span>#{show.id}</span>
              {seasons && (
                <>
                  <span className="text-white/15">·</span>
                  <span>{seasons.length} season{seasons.length !== 1 ? "s" : ""}</span>
                  <span className="text-white/15">·</span>
                  <span>{seasons.reduce((a, s) => a + s.episodeCount, 0)} episodes</span>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Content */}
      <div className="relative z-10 flex-1 px-8 pb-8 flex flex-col min-h-0">
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
            <div className="flex items-center gap-3 shrink-0">
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

              {/* Season-level search / grab */}
              {activeSeason !== null && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSearchTarget({ season: activeSeason })}
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors"
                  >
                    <SearchIcon className="size-3" /> Search Season
                  </button>
                  <button
                    type="button"
                    onClick={autoGrabSeason}
                    disabled={grabTarget === 'season'}
                    className="flex items-center gap-1.5 rounded-full bg-white/[0.04] hover:bg-white/[0.07] text-muted-foreground hover:text-foreground px-3 py-1 font-mono text-caption uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    {grabTarget === 'season' ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <DownloadIcon className="size-3" />
                    )}
                    Auto Grab Season
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
          onGrabbed={(message) => {
            flashStatus(message, /grabbed/i.test(message));
            loadEpisodes();
          }}
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
    </div>
  );
}

export { ShowDetail };
