import { Check, ChevronDown, ChevronRight, Copy, FolderArchive, Loader2, RefreshCw, X } from "lucide-react";
import * as React from "react";

interface FolderDuplicateGroup {
  key: string;
  rootFolder: string;
  canonicalFolder: string;
  folders: {
    path: string;
    name: string;
    fileCount: number;
    currentFileCount: number;
    showId: string | null;
    showTitle: string | null;
  }[];
  wouldMove: { from: string; to: string }[];
}

function DuplicatesDialog({
  open,
  onOpenChange,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged?: () => void;
}) {
  const [groups, setGroups] = React.useState<FolderDuplicateGroup[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [confirming, setConfirming] = React.useState<Set<string>>(new Set());
  const [consolidating, setConsolidating] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/shows/duplicates");
      if (!res.ok) throw new Error("Failed to load overlapping folders");
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load overlapping folders");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (open) load();
  }, [open]);

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function consolidate(group: FolderDuplicateGroup) {
    const id = `${group.rootFolder}:${group.key}`;
    setConsolidating(id);
    setError(null);
    try {
      const res = await fetch("/api/shows/duplicates/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootFolder: group.rootFolder, key: group.key }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Consolidation failed");
      }
      setConfirming((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
      onMerged?.();
    } catch (err: any) {
      setError(err.message ?? "Consolidation failed");
    } finally {
      setConsolidating(null);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-xl border border-white/10 bg-[#15181f] shadow-2xl"
        style={{ backdropFilter: "blur(16px)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <FolderArchive className="size-4 text-signal" />
            <h3 className="font-display text-lg font-semibold text-white/90">Overlapping Folders</h3>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" /> Scanning folders...
            </div>
          )}

          {!loading && error && (
            <p className="text-xs text-red-400 rounded border border-red-500/30 bg-red-500/5 px-3 py-2">{error}</p>
          )}

          {!loading && !error && (groups ?? []).length === 0 && (
            <div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
              <RefreshCw className="size-4" /> No overlapping folders detected.
            </div>
          )}

          {!loading && !error && (groups ?? []).map((group) => {
            const id = `${group.rootFolder}:${group.key}`;
            const isExpanded = expanded.has(id);
            const isConfirming = confirming.has(id);
            const isBusy = consolidating === id;
            return (
              <div key={id} className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleExpand(id)}
                  className="w-full flex items-center justify-between px-4 py-2.5 border-b border-white/5 text-left hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isExpanded ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
                    <span className="truncate text-sm text-white/90">{group.key}</span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0">
                    {group.folders.length} folders · {group.wouldMove.length} files
                  </span>
                </button>

                {isExpanded && (
                  <>
                    <div className="px-4 py-2.5 border-b border-white/5 bg-white/[0.01]">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Library root</div>
                      <div className="truncate font-mono text-xs text-white/70">{group.rootFolder}</div>
                    </div>

                    <div className="divide-y divide-white/[0.04]">
                      {group.folders.map((f) => {
                        const isCanonical = f.path === group.canonicalFolder;
                        return (
                          <div key={f.path} className="flex items-center gap-3 px-4 py-2.5">
                            {isCanonical && (
                              <span className="rounded bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider shrink-0">keep</span>
                            )}
                            {!isCanonical && (
                              <span className="rounded bg-amber-500/15 text-amber-400 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider shrink-0">merge</span>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm text-white/90">{f.name}</div>
                              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                <span>{f.fileCount} files</span>
                                {f.currentFileCount > 0 && <span>· {f.currentFileCount} tracked</span>}
                                {f.showTitle && <span className="truncate">· {f.showTitle}</span>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="border-t border-white/5 bg-white/[0.01]">
                      <div className="px-4 py-2.5 max-h-48 overflow-y-auto space-y-1">
                        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                          {group.wouldMove.length} file{group.wouldMove.length === 1 ? "" : "s"} will move
                        </div>
                        {group.wouldMove.slice(0, 50).map((m, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[11px]">
                            <Copy className="size-3 text-muted-foreground/50 shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-white/70 font-mono">{m.from}</div>
                              <div className="text-muted-foreground/70 font-mono">→ {m.to}</div>
                            </div>
                          </div>
                        ))}
                        {group.wouldMove.length > 50 && (
                          <div className="text-[11px] text-muted-foreground/60 pt-1">
                            … and {group.wouldMove.length - 50} more
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/5">
                        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 min-w-0">
                          <span className="shrink-0 mt-0.5">⚠</span>
                          <span className="min-w-0">
                            Moves every file from the <span className="text-amber-400/80">merge</span> folders into the{" "}
                            <span className="text-emerald-400/80">keep</span> folder and rewrites tracked paths.
                          </span>
                        </p>
                        {isConfirming ? (
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => setConfirming((prev) => {
                                const next = new Set(prev);
                                next.delete(id);
                                return next;
                              })}
                              disabled={isBusy}
                              className="rounded-md border border-white/10 text-muted-foreground hover:text-white text-xs font-medium px-2.5 py-1.5 transition-colors disabled:opacity-50"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => consolidate(group)}
                              disabled={isBusy}
                              className="flex items-center gap-1.5 rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-xs font-medium px-2.5 py-1.5 transition-colors disabled:opacity-50"
                            >
                              {isBusy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                              {isBusy ? "Consolidating..." : "Confirm consolidation"}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirming((prev) => new Set(prev).add(id))}
                            className="flex items-center gap-1.5 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-xs font-medium px-2.5 py-1.5 transition-colors shrink-0"
                          >
                            <FolderArchive className="size-3" />
                            Approve & consolidate
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { DuplicatesDialog };