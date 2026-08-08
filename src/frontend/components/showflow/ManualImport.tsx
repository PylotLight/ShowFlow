import { CheckIcon, FileIcon, Loader2Icon, RefreshCwIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@frontend/components/ui/button";
import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
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

export function ManualImport({ onRefresh }: { onRefresh?: () => void }) {
  const [files, setFiles] = React.useState<WatchFile[] | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [importResults, setImportResults] = React.useState<ActionResult[] | null>(null);
  const [deleteResults, setDeleteResults] = React.useState<ActionResult[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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

  const doAction = async (action: string) => {
    const selectedFiles = Array.from(selected);
    if (selectedFiles.length === 0) return;

    setBusy(true);
    setError(null);
    if (action === "import") setImportResults(null);
    else setDeleteResults(null);

    try {
      const res = await fetch(`/api/manual-import/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selectedFiles }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Server error: ${res.status}`);
      }
      const data = await res.json();
      if (action === "import") setImportResults(data.results);
      else setDeleteResults(data.results);
      setSelected(new Set());
      setTimeout(() => { load(); onRefresh?.(); }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <GlassPanel className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-display text-base font-semibold tracking-wide text-white/90">Manual Import</h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              All files currently in the watch folder. Force-import to bypass upgrade/duplicate rules, or delete unwanted files.
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
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
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
                        {f.show || <span className="italic text-muted-foreground">unresolved</span>}
                      </td>
                      <td className="px-2 py-2.5 text-foreground/70">
                        {f.season != null ? f.season : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-2 py-2.5 text-foreground/70">
                        {f.episodes?.length
                          ? f.episodes.map((e) => `E${String(e).padStart(2, "0")}`).join(", ")
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-2 py-2.5 text-foreground/70 max-w-[160px] truncate" title={f.existingFile}>
                        {f.existingFile || <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-2 py-2.5">
                        {f.resolved ? (
                          <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400 font-mono">Resolved</span>
                        ) : f.error ? (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive font-mono" title={f.error}>Error</span>
                        ) : (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400 font-mono">Unresolved</span>
                        )}
                      </td>
                    </tr>
                  ))}
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
    </div>
  );
}
