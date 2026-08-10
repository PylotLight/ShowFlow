import { CheckIcon, FileIcon, Loader2Icon, RefreshCwIcon, Trash2Icon, UploadIcon, XIcon, SearchIcon, Edit3Icon, TvIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@frontend/components/ui/dialog";
import { Input } from "@frontend/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@frontend/components/ui/select";
import { cn } from "@frontend/lib/utils";

interface WatchFile {
  filename: string;
  fullPath: string;
  show?: string;
  showId?: string;
  season?: number;
  episodes?: number[];
  existingFile?: string;
  resolved: boolean;
  error?: string;
}

interface ActionResult {
  filename: string;
  ok: boolean;
  message: string;
}

interface LibraryShow {
  id: string;
  title: string;
  year?: number;
}

interface EpisodeOverride {
  season?: number;
  episodes?: number[];
}

/** Best-effort SxxEyy-style parse of a filename for season/episode numbers. */
function sniffEpisodeNumbers(filename: string): { season?: number; episodes: number[] } | null {
  const base = filename.replace(/\.[^.]+$/, "");

  // S01E02, S01E02E03E04, s1e2, S01.E02 ...
  const sxey = [...base.matchAll(/[sS](\d{1,3})[.\-_ ]?[eE](\d{1,4})/g)];
  if (sxey.length > 0) {
    const first = sxey[0]!;
    const season = parseInt(first[1]!, 10);
    // Collect every E-number after an S-number block, including chained E02E03.
    const episodes: number[] = [];
    const afterFirst = base.slice(first.index);
    const epMatches = [...afterFirst.matchAll(/[eE](\d{1,4})/g)];
    for (const m of epMatches) episodes.push(parseInt(m[1]!, 10));
    if (episodes.length === 0) episodes.push(parseInt(first[2]!, 10));
    return { season: Number.isFinite(season) ? season : undefined, episodes: Array.from(new Set(episodes)) };
  }

  // 1x02 style
  const axb = base.match(/(\d{1,3})x(\d{1,4})/);
  if (axb) {
    return { season: parseInt(axb[1]!, 10), episodes: [parseInt(axb[2]!, 10)] };
  }

  // " - 02 ", "[02]", "E02", "#02" standalone episode (no season)
  const epOnly = base.match(/(?:^|[\s\-_.\[\]#])[eE]?(\d{1,3})(?:[\s\-_.\]\[]|$)(?!.*\d{1,3}x)/);
  if (epOnly) {
    return { episodes: [parseInt(epOnly[1]!, 10)] };
  }

  return null;
}

export function ManualImport({ onRefresh }: { onRefresh?: () => void }) {
  const [files, setFiles] = React.useState<WatchFile[] | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [importResults, setImportResults] = React.useState<ActionResult[] | null>(null);
  const [deleteResults, setDeleteResults] = React.useState<ActionResult[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Manual show override state
  const [assignedShows, setAssignedShows] = React.useState<Record<string, LibraryShow>>({});
  const [episodeOverrides, setEpisodeOverrides] = React.useState<Record<string, EpisodeOverride>>({});
  const [selectingFile, setSelectingFile] = React.useState<WatchFile | null>(null);
  const [libraryShows, setLibraryShows] = React.useState<LibraryShow[]>([]);
  const [showSearchQuery, setShowSearchQuery] = React.useState("");

  // Season/episode selector data, keyed by library show id
  const [seasonsByShow, setSeasonsByShow] = React.useState<Record<string, number[]>>({});
  const [episodesBySeason, setEpisodesBySeason] = React.useState<Record<string, { season: number; episode: number; title?: string }[]>>({});
  const [episodePickFile, setEpisodePickFile] = React.useState<WatchFile | null>(null);
  const [pickSelection, setPickSelection] = React.useState<number[]>([]);

  const load = React.useCallback(() => {
    setError(null);
    setImportResults(null);
    setDeleteResults(null);
    fetch("/api/manual-import/list")
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => null);
          throw new Error(data?.error || `Failed to load watch folder (${r.status})`);
        }
        return r.json();
      })
      .then((data: WatchFile[]) => {
        setFiles(Array.isArray(data) ? data : []);
        setSelected(new Set());
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setFiles(null);
      });

    // Fetch existing library shows for the quick picker
    fetch("/api/shows")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setLibraryShows(data.map((s) => ({ id: s.id, title: s.title, year: s.year })));
        }
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // Preload season/episode data for shows already matched in the watch folder,
  // so the season/episode selectors are populated without an extra assign step.
  React.useEffect(() => {
    if (!Array.isArray(files)) return;
    const showIds = new Set<string>();
    for (const f of files) {
      const id = assignedShows[f.filename]?.id ?? f.showId;
      if (id) {
        showIds.add(id);
        const season = episodeOverrides[f.filename]?.season ?? f.season;
        if (season != null) fetchSeasonEpisodes(id, season);
      }
    }
    for (const id of showIds) fetchShowSeasons(id);
  }, [files, assignedShows, episodeOverrides]);

  const toggleAll = () => {
    if (!files) return;
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((f) => f.filename)));
    }
  };

  const toggleFile = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const fetchShowSeasons = (showId: string) => {
    if (!showId || seasonsByShow[showId]) return;
    fetch(`/api/shows/${showId}/seasons`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setSeasonsByShow((prev) => ({ ...prev, [showId]: (data as { seasonNumber: number }[]).map((s) => s.seasonNumber) }));
        }
      })
      .catch(() => {});
  };

  const fetchSeasonEpisodes = (showId: string, season: number) => {
    if (!showId) return;
    const key = `${showId}:${season}`;
    if (episodesBySeason[key]) return;
    fetch(`/api/shows/${showId}/seasons/${season}/episodes`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setEpisodesBySeason((prev) => ({ ...prev, [key]: data as { season: number; episode: number; title?: string }[] }));
        }
      })
      .catch(() => {});
  };

  const handleAssignShow = (show: LibraryShow) => {
    if (!selectingFile) return;
    const file = selectingFile;
    setAssignedShows((prev) => ({
      ...prev,
      [file.filename]: show,
    }));
    fetchShowSeasons(show.id);

    // Try to re-resolve season/episodes automatically now that the series is known.
    // Reuse the parsed values if the file already resolved (f.season/f.episodes), otherwise
    // sniff SxxEyy patterns from the filename. Only set an override when there's no
    // existing override already (don't stomp manual edits).
    if (file.season != null || file.episodes?.length) {
      fetchSeasonEpisodes(show.id, file.season ?? 0);
    } else {
      const sniffed = sniffEpisodeNumbers(file.filename);
      if (sniffed && (sniffed.season != null || sniffed.episodes.length > 0)) {
        setEpisodeOverrides((prev) =>
          prev[file.filename]
            ? prev
            : { ...prev, [file.filename]: { ...(sniffed.season != null ? { season: sniffed.season } : {}), ...(sniffed.episodes.length ? { episodes: sniffed.episodes } : {}) } }
        );
        if (sniffed.season != null) fetchSeasonEpisodes(show.id, sniffed.season);
      } else {
        // Still fetch the default season so the selector has options
        fetchSeasonEpisodes(show.id, 1);
      }
    }

    // Auto-select file for import when show is assigned
    setSelected((prev) => new Set(prev).add(file.filename));
    setSelectingFile(null);
    setShowSearchQuery("");
  };

  const clearAssignedShow = (filename: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setAssignedShows((prev) => {
      const next = { ...prev };
      delete next[filename];
      return next;
    });
    // Don't clear the episode override — user may still want manual S/E control
    // even after the show assignment is removed.
  };

  const setSeasonOverride = (filename: string, season: number | null) => {
    setEpisodeOverrides((prev) => {
      const next = { ...prev };
      const current: EpisodeOverride = { ...(next[filename] ?? {}) };

      if (season == null) delete current.season;
      else current.season = season;

      if (current.season == null && (!current.episodes || current.episodes.length === 0)) {
        delete next[filename];
      } else {
        next[filename] = current;
      }
      return next;
    });

    if (season != null) {
      const showId = assignedShows[filename]?.id ?? files?.find((fi) => fi.filename === filename)?.showId;
      if (showId) fetchSeasonEpisodes(showId, season);
    }
  };

  const setEpisodesOverride = (filename: string, episodes: number[] | null) => {
    setEpisodeOverrides((prev) => {
      const next = { ...prev };
      const current: EpisodeOverride = { ...(next[filename] ?? {}) };

      if (episodes == null || episodes.length === 0) delete current.episodes;
      else current.episodes = episodes;

      if (current.season == null && (!current.episodes || current.episodes.length === 0)) {
        delete next[filename];
      } else {
        next[filename] = current;
      }
      return next;
    });
  };

  const openEpisodePicker = (file: WatchFile) => {
    const showId = assignedShows[file.filename]?.id ?? file.showId;
    const season = episodeOverrides[file.filename]?.season ?? file.season;
    if (showId && season != null) fetchSeasonEpisodes(showId, season);
    setPickSelection(episodeOverrides[file.filename]?.episodes ?? file.episodes ?? []);
    setEpisodePickFile(file);
  };

  const togglePickEpisode = (episode: number) => {
    if (!episodePickFile) return;
    setPickSelection((prev) =>
      prev.includes(episode) ? prev.filter((e) => e !== episode) : [...prev, episode].sort((a, b) => a - b),
    );
  };

  const commitEpisodePick = () => {
    if (!episodePickFile) return;
    setEpisodesOverride(episodePickFile.filename, pickSelection.length ? pickSelection : null);
    setEpisodePickFile(null);
  };

  const doAction = async (action: string) => {
    const selectedFiles = Array.from(selected);
    if (selectedFiles.length === 0) return;

    setBusy(true);
    setError(null);
    if (action === "import") setImportResults(null);
    else setDeleteResults(null);

    try {
      const payload = action === "import"
        ? {
            files: selectedFiles.map((filename) => {
              const override = episodeOverrides[filename];
              return {
                filename,
                showId: assignedShows[filename]?.id,
                ...(override?.season != null ? { season: override.season } : {}),
                ...(override?.episodes?.length ? { episodes: override.episodes } : {}),
              };
            }),
          }
        : { files: selectedFiles };

      const res = await fetch(`/api/manual-import/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Server error: ${res.status}`);
      }
      const data = await res.json();
      if (action === "import") setImportResults(data.results);
      else setDeleteResults(data.results);
      setSelected(new Set());
      setAssignedShows({});
      setEpisodeOverrides({});
      setTimeout(() => { load(); onRefresh?.(); }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const filteredLibraryShows = libraryShows.filter((s) =>
    s.title.toLowerCase().includes(showSearchQuery.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <GlassPanel className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-wide text-white/90">Manual Import</h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              All files currently in the watch folder. Force-import to bypass upgrade/duplicate rules, select matches manually for unresolved files, or delete unwanted files.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={busy}
            className="gap-1.5"
          >
            <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {importResults && importResults.length > 0 && (
          <div className="mb-4 space-y-1">
            {importResults.map((r) => (
              <div
                key={r.filename}
                className={cn(
                  "flex items-center gap-2 rounded px-3 py-1.5 text-xs",
                  r.ok
                    ? "bg-green-500/10 text-green-400 border border-green-500/20"
                    : "bg-destructive/10 text-destructive border border-destructive/20",
                )}
              >
                {r.ok ? <CheckIcon className="size-3 shrink-0" /> : <XIcon className="size-3 shrink-0" />}
                <span className="font-mono">{r.filename}</span>
                <span className="text-muted-foreground">— {r.message}</span>
              </div>
            ))}
          </div>
        )}

        {deleteResults && deleteResults.length > 0 && (
          <div className="mb-4 space-y-1">
            {deleteResults.map((r) => (
              <div
                key={r.filename}
                className={cn(
                  "flex items-center gap-2 rounded px-3 py-1.5 text-xs",
                  r.ok
                    ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                    : "bg-destructive/10 text-destructive border border-destructive/20",
                )}
              >
                {r.ok ? <CheckIcon className="size-3 shrink-0" /> : <XIcon className="size-3 shrink-0" />}
                <span className="font-mono">{r.filename}</span>
                <span className="text-muted-foreground">— {r.message}</span>
              </div>
            ))}
          </div>
        )}

        {error ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <div className="flex items-center gap-2 mb-2">
              <XIcon className="size-5 text-destructive" />
              <span className="text-xs text-destructive font-medium">Watch folder unavailable</span>
            </div>
            <p className="text-xs text-center max-w-md">{error}</p>
            {error.toLowerCase().includes("watcher is not running") && (
              <p className="text-xs text-muted-foreground/70 mt-2 text-center max-w-md">
                The download watcher isn't running. Start it from the Queue page to scan this watch folder.
              </p>
            )}
            <Button variant="outline" size="sm" onClick={load} className="mt-4 gap-1.5">
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : files === null ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin mr-2" />
            <span className="text-xs">Loading watch folder...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <FileIcon className="size-8 mb-2 opacity-30" />
            <p className="text-xs">No files waiting in the watch folder.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-muted-foreground">
                    <th className="w-8 px-2 py-2 text-left">
                      <input
                        type="checkbox"
                        checked={files.length > 0 && selected.size === files.length}
                        onChange={toggleAll}
                        className="rounded border-white/20 bg-white/5"
                      />
                    </th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">File</th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">Show</th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">Season</th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">Episodes</th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">Existing</th>
                    <th className="px-2 py-2 text-left font-mono font-medium uppercase tracking-wider">Status</th>
                    <th className="px-2 py-2 text-right font-mono font-medium uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => {
                    const override = assignedShows[f.filename];
                    const epOverride = episodeOverrides[f.filename];
                    const currentShowTitle = override ? override.title : f.show;
                    const displaySeason = epOverride?.season ?? f.season;
                    const displayEpisodes = epOverride?.episodes ?? f.episodes;

                    const assignedShow = assignedShows[f.filename];
                    const assignedShowId = assignedShow?.id ?? f.showId;
                    const seasonOptions = assignedShowId && seasonsByShow[assignedShowId]?.length
                      ? seasonsByShow[assignedShowId]
                      : (() => {
                          const maxSeason = Math.max(40, displaySeason ?? 0);
                          return Array.from({ length: maxSeason + 1 }, (_, i) => i); // Specials (0) .. max
                        })();

                    const seasonCellContent = (
                      <Select
                        value={displaySeason != null ? String(displaySeason) : undefined}
                        onValueChange={(v) => setSeasonOverride(f.filename, v === "__auto__" ? null : parseInt(v, 10))}
                      >
                        <SelectTrigger
                          size="sm"
                          className={cn(
                            "h-7 text-[11px] px-2 min-w-16",
                            epOverride?.season != null && "border-signal/50 text-signal font-medium",
                          )}
                        >
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          {epOverride?.season != null && (
                            <SelectItem value="__auto__">
                              Auto{f.season != null ? ` (S${f.season})` : ""}
                            </SelectItem>
                          )}
                          {seasonOptions.map((s) => (
                            <SelectItem key={s} value={String(s)}>
                              {s === 0 ? "Specials" : `Season ${s}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );

                    const episodesCellContent = (
                      <button
                        type="button"
                        onClick={() => openEpisodePicker(f)}
                        className={cn(
                          "rounded px-1.5 py-1 hover:bg-white/5 transition-colors text-left max-w-[120px] truncate",
                          epOverride?.episodes?.length && "text-signal font-medium",
                        )}
                        title="Select episodes"
                      >
                        {displayEpisodes?.length
                          ? displayEpisodes.map((n) => `E${String(n).padStart(2, "0")}`).join(", ")
                          : <span className="text-muted-foreground">—</span>}
                      </button>
                    );

                    return (
                      <tr
                        key={f.filename}
                        className={cn(
                          "border-b border-white/5 transition-colors",
                          selected.has(f.filename) ? "bg-signal/5" : "hover:bg-white/[0.02]",
                        )}
                      >
                        <td className="px-2 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(f.filename)}
                            onChange={() => toggleFile(f.filename)}
                            className="rounded border-white/20 bg-white/5"
                          />
                        </td>
                        <td className="px-2 py-2.5 font-mono text-foreground/85 max-w-[200px] truncate" title={f.filename}>
                          {f.filename}
                        </td>
                        <td className="px-2 py-2.5 text-foreground/70">
                          {override ? (
                            <div className="flex items-center gap-1 text-signal font-medium">
                              <span title={`Manually assigned to ${override.title}`}>{override.title}</span>
                              <button
                                type="button"
                                onClick={(e) => clearAssignedShow(f.filename, e)}
                                className="text-muted-foreground hover:text-destructive transition-colors ml-1"
                                title="Reset show assignment"
                              >
                                <XIcon className="size-3" />
                              </button>
                            </div>
                          ) : (
                            currentShowTitle || <span className="italic text-muted-foreground">unresolved</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-foreground/70">
                          {seasonCellContent}
                        </td>
                        <td className="px-2 py-2.5 text-foreground/70">
                          {episodesCellContent}
                        </td>
                        <td className="px-2 py-2.5 text-foreground/70 max-w-[160px] truncate" title={f.existingFile}>
                          {f.existingFile || <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-2.5">
                          {override || epOverride ? (
                            <span
                              className="rounded bg-signal/10 px-1.5 py-0.5 text-[10px] text-signal font-mono"
                              title={override ? "Manually assigned show" : "Season/episode overridden"}
                            >
                              {override ? "Assigned" : "Modified"}
                            </span>
                          ) : f.resolved ? (
                            <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400 font-mono" title="Matched to library show">Resolved</span>
                          ) : f.error ? (
                            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive font-mono" title={f.error}>{f.error}</span>
                          ) : (
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400 font-mono" title="Unresolved - click 'Match Show' to manually assign">Unresolved</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectingFile(f)}
                            className="h-7 text-[11px] px-2 gap-1 text-muted-foreground hover:text-foreground"
                          >
                            <Edit3Icon className="size-3" />
                            Match Show
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
              <span className="text-xs text-muted-foreground">
                {selected.size} of {files.length} file{files.length !== 1 ? "s" : ""} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => doAction("delete")}
                  disabled={selected.size === 0 || busy}
                  variant="outline"
                  className="gap-1.5 text-destructive hover:text-destructive"
                  size="sm"
                >
                  <Trash2Icon className="size-3.5" />
                  Delete ({selected.size})
                </Button>
                <Button
                  onClick={() => doAction("import")}
                  disabled={selected.size === 0 || busy}
                  className="gap-1.5"
                  size="sm"
                >
                  {busy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <UploadIcon className="size-3.5" />
                  )}
                  Force Import ({selected.size})
                </Button>
              </div>
            </div>
          </>
        )}
      </GlassPanel>

      {/* Show Selection Modal */}
      <Dialog open={!!selectingFile} onOpenChange={(open) => !open && setSelectingFile(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold flex items-center gap-2">
              <TvIcon className="size-5 text-signal" />
              Assign Show
            </DialogTitle>
            <DialogDescription className="text-xs">
              Select a show from your library to associate with <span className="font-mono text-foreground">{selectingFile?.filename}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Filter library shows..."
                value={showSearchQuery}
                onChange={(e) => setShowSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
              {filteredLibraryShows.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {libraryShows.length === 0 ? "No shows in library." : "No shows match your filter."}
                </p>
              ) : (
                filteredLibraryShows.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => handleAssignShow(s)}
                    className="w-full text-left rounded-lg p-2.5 hover:bg-white/5 transition-colors border border-transparent hover:border-white/10 flex items-center justify-between group"
                  >
                    <div>
                      <div className="text-xs font-medium text-foreground group-hover:text-signal transition-colors">
                        {s.title}
                      </div>
                      {s.year && <div className="text-[10px] text-muted-foreground">{s.year}</div>}
                    </div>
                    <CheckIcon className="size-4 text-signal opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Episode Selector Dialog */}
      <Dialog open={!!episodePickFile} onOpenChange={(open) => !open && setEpisodePickFile(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold flex items-center gap-2">
              <TvIcon className="size-5 text-signal" />
              Select Episodes
            </DialogTitle>
            <DialogDescription className="text-xs">
              Choose which episode numbers this file should import as.{" "}
              <span className="font-mono text-foreground">{episodePickFile?.filename}</span>
              {episodePickFile && (
                <> — Season {episodeOverrides[episodePickFile.filename]?.season ?? episodePickFile.season ?? "?"}</>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {(() => {
              if (!episodePickFile) return null;
              const showId = assignedShows[episodePickFile.filename]?.id ?? episodePickFile.showId;
              const season = episodeOverrides[episodePickFile.filename]?.season ?? episodePickFile.season;
              const episodes = showId && season != null
                ? episodesBySeason[`${showId}:${season}`]
                : undefined;
              const fallbackEpisodes = episodes?.length
                ? episodes.map((e) => e.episode).sort((a, b) => a - b)
                : undefined;
              const total = fallbackEpisodes?.[fallbackEpisodes.length - 1];
              const grid = fallbackEpisodes ?? Array.from(
                { length: Math.max(total ?? 0, pickSelection.length ? Math.max(...pickSelection) : 0, episodePickFile.episodes?.length ? Math.max(...episodePickFile.episodes) : 0, 12) },
                (_, i) => i + 1,
              );

              return (
                <>
                  <div className="grid grid-cols-6 gap-1.5 max-h-56 overflow-y-auto pr-1">
                    {grid.map((n) => {
                      const selected = pickSelection.includes(n);
                      return (
                        <button
                          key={n}
                          type="button"
                          onClick={() => togglePickEpisode(n)}
                          className={cn(
                            "rounded-md border py-1.5 text-[11px] font-mono transition-colors",
                            selected
                              ? "border-signal/60 bg-signal/15 text-signal font-medium"
                              : "border-white/10 text-foreground/80 hover:border-white/25 hover:bg-white/5",
                          )}
                        >
                          E{String(n).padStart(2, "0")}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-muted-foreground">
                      {pickSelection.length} selected
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPickSelection([])}
                        className="h-8 text-[11px]"
                      >
                        Clear
                      </Button>
                      <Button size="sm" onClick={commitEpisodePick} className="h-8 text-[11px] gap-1.5">
                        <CheckIcon className="size-3.5" />
                        Apply
                      </Button>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

