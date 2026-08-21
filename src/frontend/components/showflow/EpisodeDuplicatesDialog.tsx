import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw, X, FolderArchive } from "lucide-react";
import * as React from "react";

interface EpisodeDupFile {
  path: string;
  name: string;
  size: number | null;
  onDisk: boolean;
  isCurrent: boolean;
  rowId: number | null;
  score: number;
  quality: string | null;
  media: {
    container?: string | null;
    videoHeight?: number | null;
    videoWidth?: number | null;
    videoCodec?: string | null;
    hdr?: boolean;
    audioCodec?: string | null;
    bitrateKbps?: number | null;
  } | null;
}

interface EpisodeDuplicateGroup {
  showId: string;
  season: number;
  episode: number;
  title: string | null;
  files: EpisodeDupFile[];
  best: string | null;
  onDiskCount: number;
  trackedCount: number;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : v >= 100 ? 1 : 2)} ${units[u]}`;
}

function mediaLabel(f: EpisodeDupFile): string {
  const m = f.media;
  if (!m) return "";
  const parts: string[] = [];
  if (m.videoHeight) parts.push(`${m.videoHeight}p`);
  if (m.videoCodec) parts.push(m.videoCodec.toUpperCase());
  if (m.hdr) parts.push("HDR");
  if (m.audioCodec) parts.push(m.audioCodec.toUpperCase());
  if (m.bitrateKbps) parts.push(`${Math.round(m.bitrateKbps / 1000)} Mbps`);
  return parts.join(" · ");
}

function EpisodeDuplicatesDialog({
  showId,
  open,
  onOpenChange,
  onResolved,
}: {
  showId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved?: () => void;
}) {
  const [groups, setGroups] = React.useState<EpisodeDuplicateGroup[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [resolving, setResolving] = React.useState<string | null>(null);
  const [keeps, setKeeps] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);

  async function load() {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shows/${showId}/episode-duplicates`);
      if (!res.ok) throw new Error("Failed to load episode duplicates");
      const data = await res.json();
      const gs: EpisodeDuplicateGroup[] = data.groups ?? [];
      setGroups(gs);
      setKeeps(Object.fromEntries(gs.map((g) => [`${g.season}:${g.episode}`, g.best ?? g.files[0]?.path ?? ""])));
    } catch (err: any) {
      setError(err.message ?? "Failed to load episode duplicates");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (open) load();
  }, [open, showId]);

  async function resolve(group: EpisodeDuplicateGroup) {
    const id = `${group.season}:${group.episode}`;
    const keepPath = keeps[id];
    if (!keepPath) return;
    setResolving(id);
    setError(null);
    try {
      const res = await fetch(`/api/shows/${showId}/episode-duplicates/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: group.season, episode: group.episode, keepPath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Resolution failed");
      }
      await load();
      onResolved?.();
    } catch (err: any) {
      setError(err.message ?? "Resolution failed");
    } finally {
      setResolving(null);
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
            <h3 className="font-display text-lg font-semibold text-white/90">Duplicate Episodes</h3>
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
              <Loader2 className="size-4 animate-spin" /> Scanning episode files...
            </div>
          )}

          {!loading && error && (
            <p className="text-xs text-red-400 rounded border border-red-500/30 bg-red-500/5 px-3 py-2">{error}</p>
          )}

          {!loading && !error && (groups ?? []).length === 0 && (
            <div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
              <RefreshCw className="size-4" /> No duplicate episodes detected.
            </div>
          )}

          {!loading && !error && (groups ?? []).map((group) => {
            const id = `${group.season}:${group.episode}`;
            const keepPath = keeps[id] ?? "";
            return (
              <div key={id} className="rounded-xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 bg-white/[0.01]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-white/90 shrink-0">S{group.season}E{group.episode}</span>
                    <span className="truncate text-sm text-white/70">{group.title || ""}</span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0">
                    {group.files.length} file{group.files.length === 1 ? "" : "s"} · {group.onDiskCount} on disk
                  </span>
                </div>

                <div className="divide-y divide-white/[0.04]">
                  {group.files.map((f) => {
                    const isBest = f.path === group.best;
                    const isKept = f.path === keepPath;
                    const isCurrent = f.isCurrent;
                    return (
                      <label key={f.path} className={`flex items-start gap-3 px-4 py-2.5 cursor-pointer ${!f.onDisk ? "opacity-50" : ""}`}>
                        <input
                          type="radio"
                          name={id}
                          checked={isKept}
                          onChange={() => setKeeps((prev) => ({ ...prev, [id]: f.path }))}
                          disabled={!f.onDisk}
                          className="mt-0.5 accent-emerald-400"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="truncate text-sm text-white/90">{f.name}</span>
                            {isBest && f.onDisk && (
                              <span className="rounded bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider shrink-0">best</span>
                            )}
                            {isCurrent && (
                              <span className="rounded bg-sky-500/10 text-sky-400 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider shrink-0">tracked</span>
                            )}
                            {!f.onDisk && (
                              <span className="rounded bg-red-500/10 text-red-400 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider shrink-0">missing</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                            <span>{formatSize(f.size)}</span>
                            {f.quality && <span className="text-signal/80">{f.quality}</span>}
                            {mediaLabel(f) && <span>{mediaLabel(f)}</span>}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/5">
                  <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 min-w-0">
                    <span className="shrink-0 mt-0.5">⚠</span>
                    <span className="min-w-0">
                      Keeps the selected file, deletes the other on-disk copies and reconciles tracked paths.
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => resolve(group)}
                    disabled={resolving === id}
                    className="flex items-center gap-1.5 rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-xs font-medium px-2.5 py-1.5 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {resolving === id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                    {resolving === id ? "Resolving..." : "Keep selected & delete others"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { EpisodeDuplicatesDialog };
