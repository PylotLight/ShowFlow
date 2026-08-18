import { AlertTriangle, Copy, GitCompareArrows, Loader2, RefreshCw, X } from "lucide-react";
import * as React from "react";

interface DuplicateShowInfo {
  id: string;
  title: string;
  year: number | null;
  seriesType: string | null;
  providerId: string | null;
  providerType: string | null;
  episodeCount: number;
  currentFileCount: number;
  rootFolderPath: string | null;
  folderName: string | null;
}

interface DuplicateGroup {
  key: string;
  confidence: "high" | "fuzzy";
  reason: string;
  shows: DuplicateShowInfo[];
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
  const [groups, setGroups] = React.useState<DuplicateGroup[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [merging, setMerging] = React.useState<Set<string>>(new Set());
  const [mergingSafe, setMergingSafe] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/shows/duplicates");
      if (!res.ok) throw new Error("Failed to load duplicates");
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load duplicates");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (open) load();
  }, [open]);

  const hasDuplicates = (groups ?? []).some(g => g.shows.length > 1);

  async function merge(targetId: string, sourceId: string) {
    const key = `${targetId}:${sourceId}`;
    setMerging((prev) => new Set(prev).add(key));
    setError(null);
    try {
      const res = await fetch(`/api/shows/${targetId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceShowId: sourceId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Merge failed");
      }
      await load();
      onMerged?.();
    } catch (err: any) {
      setError(err.message ?? "Merge failed");
    } finally {
      setMerging((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function mergeAllSafe() {
    setMergingSafe(true);
    setError(null);
    try {
      const res = await fetch("/api/shows/duplicates/merge-safe", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Merge failed");
      }
      await load();
      onMerged?.();
    } catch (err: any) {
      setError(err.message ?? "Merge failed");
    } finally {
      setMergingSafe(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-white/10 bg-[#15181f] shadow-2xl"
        style={{ backdropFilter: "blur(16px)" }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2">
            <GitCompareArrows className="size-4 text-signal" />
            <h3 className="font-display text-lg font-semibold text-white/90">Duplicate Shows</h3>
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
              <Loader2 className="size-4 animate-spin" /> Detecting duplicates...
            </div>
          )}

          {!loading && error && (
            <p className="text-xs text-red-400 rounded border border-red-500/30 bg-red-500/5 px-3 py-2">{error}</p>
          )}

          {!loading && !error && (groups ?? []).length === 0 && (
            <div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
              <RefreshCw className="size-4" /> No duplicate shows detected.
            </div>
          )}

          {!loading && hasDuplicates && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={mergeAllSafe}
                disabled={mergingSafe}
                className="flex items-center gap-2 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium px-4 py-2 transition-colors disabled:opacity-50"
              >
                {mergingSafe ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitCompareArrows className="size-3.5" />
                )}
                {mergingSafe ? "Merging..." : "Auto-merge safe matches"}
              </button>
              <p className="text-[11px] text-muted-foreground">
                Merges groups with identical normalized titles (keeps the show with the most files).
              </p>
            </div>
          )}

          {!loading && !error && (groups ?? []).map((group, gi) => (
            <div key={gi} className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      group.confidence === "high"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    {group.confidence === "high" ? "safe" : "fuzzy"}
                  </span>
                  <span className="text-xs text-muted-foreground">{group.reason}</span>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground/50">{group.shows.length} shows</span>
              </div>

              <div className="divide-y divide-white/[0.04]">
                {group.shows.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white/90">{s.title}</div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {s.year != null && <span>{s.year}</span>}
                        {s.providerType && (
                          <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">
                            {s.providerType}:{s.providerId}
                          </span>
                        )}
                        <span>{s.currentFileCount} files</span>
                        {s.folderName && <span className="truncate font-mono text-[10px] text-muted-foreground/60">📁 {s.folderName}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {group.confidence === "high" && (
                <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-white/5 bg-white/[0.01]">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mr-1">Merge into</span>
                  {group.shows.map((target) => (
                    <div key={target.id} className="flex items-center gap-1">
                      <span className="hidden">{target.title}</span>
                      {group.shows.filter((d) => d.id !== target.id).map((dup) => {
                        const key = `${target.id}:${dup.id}`;
                        const busy = merging.has(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={busy}
                            onClick={() => merge(target.id, dup.id)}
                            className="flex items-center gap-1.5 rounded-md border border-white/10 text-muted-foreground hover:text-signal hover:border-signal/40 text-xs font-medium px-2 py-1 transition-colors disabled:opacity-50"
                          >
                            {busy ? <Loader2 className="size-3 animate-spin" /> : <Copy className="size-3" />}
                            {target.title} ← {dup.title}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {group.confidence === "fuzzy" && (
                <div className="px-4 py-3 border-t border-white/5 bg-white/[0.01]">
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                    <AlertTriangle className="size-3 text-amber-400 shrink-0 mt-0.5" />
                    Similar-but-not-identical titles. Review before merging — these could be different shows.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { DuplicatesDialog };
