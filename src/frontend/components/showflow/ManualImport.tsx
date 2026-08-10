import { CheckIcon, FileIcon, Loader2Icon, RefreshCwIcon, Trash2Icon, UploadIcon, XIcon, SearchIcon, Edit3Icon, TvIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@frontend/components/ui/dialog";
import { Input } from "@frontend/components/ui/input";
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

  // Edit state for season/episode cells
  const [editingCell, setEditingCell] = React.useState<{ filename: string; field: "season" | "episodes" } | null>(null);
  const [editValue, setEditValue] = React.useState("");

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

  const handleAssignShow = (show: LibraryShow) => {
    if (!selectingFile) return;
    setAssignedShows((prev) => ({
      ...prev,
      [selectingFile.filename]: show,
    }));
    // Auto-select file for import when show is assigned
    setSelected((prev) => new Set(prev).add(selectingFile.filename));
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

  const startEditCell = (filename: string, field: "season" | "episodes", current: string) => {
    setEditingCell({ filename, field });
    setEditValue(current);
  };

  const commitEditCell = () => {
    if (!editingCell) return;
    const { filename, field } = editingCell;
    const raw = editValue.trim();

    setEpisodeOverrides((prev) => {
      const next = { ...prev };
      const current: EpisodeOverride = { ...(next[filename] ?? {}) };

      if (field === "season") {
        if (raw === "") delete current.season;
        else {
          const num = parseInt(raw, 10);
          if (Number.isFinite(num) && num >= 0) current.season = num;
        }
      } else {
        if (raw === "") delete current.episodes;
        else {
          const list = raw.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
          if (list.length > 0) current.episodes = list;
        }
      }

      if (current.season == null && (!current.episodes || current.episodes.length === 0)) {
        delete next[filename];
      } else {
        next[filename] = current;
      }
      return next;
    });

    setEditingCell(null);
    setEditValue("");
  };

  const cancelEditCell = () => {
    setEditingCell(null);
    setEditValue("");
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
                    const editingThisSeason = editingCell?.filename === f.filename && editingCell.field === "season";
                    const editingThisEpisodes = editingCell?.filename === f.filename && editingCell.field === "episodes";

                    const seasonCellContent = editingThisSeason ? (
                      <input
                        autoFocus
                        type="number"
                        min={0}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEditCell}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEditCell();
                          if (e.key === "Escape") cancelEditCell();
                        }}
                        className="w-14 rounded border border-signal/50 bg-white/5 px-1 py-0.5 text-xs text-foreground focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEditCell(f.filename, "season", displaySeason != null ? String(displaySeason) : "")}
                        className={cn(
                          "rounded px-1 py-0.5 hover:bg-white/5 transition-colors",
                          epOverride?.season != null && "text-signal font-medium",
                        )}
                        title="Click to override season"
                      >
                        {displaySeason != null ? displaySeason : <span className="text-muted-foreground">—</span>}
                      </button>
                    );

                    const episodesCellContent = editingThisEpisodes ? (
                      <input
                        autoFocus
                        type="text"
                        placeholder="1, 2, 3"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={commitEditCell}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEditCell();
                          if (e.key === "Escape") cancelEditCell();
                        }}
                        className="w-24 rounded border border-signal/50 bg-white/5 px-1 py-0.5 text-xs text-foreground focus:outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          startEditCell(
                            f.filename,
                            "episodes",
                            displayEpisodes?.length ? displayEpisodes.join(", ") : "",
                          )
                        }
                        className={cn(
                          "rounded px-1 py-0.5 hover:bg-white/5 transition-colors text-left",
                          epOverride?.episodes?.length && "text-signal font-medium",
                        )}
                        title="Click to override episode numbers (comma separated)"
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
                placeholder="Search library shows..."
                value={showSearchQuery}
                onChange={(e) => setShowSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
              {filteredLibraryShows.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {showSearchQuery ? "No matching shows found in your library." : "No shows in library."}
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
    </div>
  );
}

