import * as React from "react";
import { Check, Loader2Icon, LockIcon, RefreshCwIcon, XIcon } from "lucide-react";

interface MappingRow {
  id: number;
  scene_season: number | null;
  scene_episode: number | null;
  scene_absolute: number | null;
  anidb_season: number | null;
  anidb_episode: number | null;
  anidb_absolute: number | null;
  target_season: number | null;
  target_episode: number | null;
  target_absolute: number | null;
  source: string;
  locked: number;
}

interface MappingSummary {
  config: {
    enabled: boolean;
    source: string;
    health: string;
    healthDetail: string[];
    lastSynced: string | null;
    lastError: string | null;
  };
  mappedCount: number;
  rows: MappingRow[];
}

const HEALTH_META: { [k: string]: { label: string; dot: string; text: string }; none: { label: string; dot: string; text: string } } = {
  ok: { label: "OK", dot: "bg-emerald-400", text: "text-emerald-400" },
  conflicts: { label: "Conflicts", dot: "bg-amber-400", text: "text-amber-400" },
  missing: { label: "No mapping", dot: "bg-slate-400", text: "text-slate-400" },
  error: { label: "Error", dot: "bg-red-400", text: "text-red-400" },
  none: { label: "Not synced", dot: "bg-slate-500", text: "text-slate-400" },
};

function prettyDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function EpisodeMappingDialog({
  showId,
  showTitle,
  open,
  onOpenChange,
  onChanged,
}: {
  showId: string;
  showTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const [summary, setSummary] = React.useState<MappingSummary | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fixRow, setFixRow] = React.useState<number | null>(null);
  const [fixSeason, setFixSeason] = React.useState("");
  const [fixEpisode, setFixEpisode] = React.useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shows/${showId}/episode-mapping`);
      if (!res.ok) throw new Error(`Failed to load mapping (${res.status})`);
      const data = (await res.json()) as MappingSummary;
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (open) {
      setSummary(null);
      setFixRow(null);
      load();
    }
  }, [open, showId]);

  async function setEnabled(enabled: boolean) {
    setBusy("toggle");
    try {
      const res = await fetch(`/api/shows/${showId}/episode-mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await res.json()) as MappingSummary;
      if (!res.ok) throw new Error("Failed to update toggle");
      setSummary(data);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/shows/${showId}/episode-mapping/refresh`, { method: "POST" });
      const data = (await res.json()) as MappingSummary;
      if (!res.ok) throw new Error("Refresh failed");
      setSummary(data);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function applyFix(row: MappingRow) {
    const targetSeason = parseInt(fixSeason, 10);
    const targetEpisode = parseInt(fixEpisode, 10);
    if (!Number.isFinite(targetSeason) || !Number.isFinite(targetEpisode)) return;
    setBusy(`row-${row.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/shows/${showId}/episode-mapping/rows/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetSeason, targetEpisode }),
      });
      const data = (await res.json()) as MappingSummary;
      if (!res.ok) throw new Error("Failed to save fix");
      setSummary(data);
      setFixRow(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function beginFix(row: MappingRow) {
    setFixRow(row.id);
    setFixSeason(String(row.target_season ?? ""));
    setFixEpisode(String(row.target_episode ?? ""));
  }

  if (!open) return null;

  const meta = HEALTH_META[summary?.config.health ?? 'none'] ?? HEALTH_META.none;
  const showFixTable = summary && summary.config.health !== 'missing' && summary.rows.length > 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }}>
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4 flex flex-col"
        style={{ backdropFilter: "blur(16px)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-semibold text-white/90">Episode Mapping</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{showTitle}</p>
          </div>
          <button onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
            <XIcon className="size-4" />
          </button>
        </div>

        {error && (
          <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/5 rounded px-2 py-1.5">{error}</div>
        )}

        {loading && !summary ? (
          <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading mapping…
          </div>
        ) : summary ? (
          <>
            {/* Toggle + health badge */}
            <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-sm text-foreground/90 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={summary.config.enabled}
                    disabled={busy === 'toggle'}
                    onChange={e => setEnabled(e.target.checked)}
                    className="size-3.5 rounded border-white/20 bg-white/5 accent-signal"
                  />
                  Use anime episode mapping
                </label>
                <span className="flex items-center gap-1.5 text-xs font-mono">
                  <span className={`size-2 rounded-full ${meta.dot}`} />
                  <span className={meta.text}>{meta.label}</span>
                  <span className="text-muted-foreground/60">· {summary.mappedCount} episodes</span>
                </span>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                Scene/anime release tags (e.g. <code className="text-foreground/70">S04E17</code>) are translated to the
                provider-native numbering (e.g. <code className="text-foreground/70">S01E53</code>) during import.
                {summary.config.enabled
                  ? " Standard shows auto-resolve without it."
                  : " Enabled automatically for anime shows."}
              </p>

              <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                <span>
                  Source: <span className="text-foreground/80 font-mono">{summary.config.source}</span>
                </span>
                <span>Last synced {prettyDate(summary.config.lastSynced)}</span>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={refreshing}
                  className="flex items-center gap-1.5 rounded-md border border-white/10 hover:bg-white/5 text-muted-foreground hover:text-foreground px-2 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:opacity-50"
                >
                  {refreshing ? <Loader2Icon className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
                  Refresh
                </button>
              </div>
            </div>

            {/* Health drill-down */}
            {summary.config.healthDetail.length > 0 && (
              <div className={`rounded-lg border px-3 py-2 space-y-1.5 ${
                summary.config.health === 'conflicts'
                  ? "border-amber-500/30 bg-amber-500/5"
                  : summary.config.health === 'error'
                    ? "border-red-500/30 bg-red-500/5"
                    : "border-white/10 bg-white/[0.02]"
              }`}>
                <div className="font-mono text-caption uppercase tracking-wider text-muted-foreground/70">What the sources say</div>
                {summary.config.healthDetail.map((d, i) => (
                  <p key={i} className="text-xs text-foreground/80 leading-relaxed">{d}</p>
                ))}
              </div>
            )}

            {/* Mapping table */}
            {showFixTable && (
              <div className="min-h-0">
                <div className="font-mono text-caption uppercase tracking-wider text-muted-foreground/70 mb-1.5">
                  Scene → Provider (scroll)
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-[#1a1e27]">
                      <tr className="text-left text-muted-foreground/70 font-mono text-caption uppercase tracking-wider">
                        <th className="px-2 py-1.5">Scene</th>
                        <th className="px-2 py-1.5">AniDB</th>
                        <th className="px-2 py-1.5">Provider</th>
                        <th className="px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {summary.rows.map(row => (
                        <React.Fragment key={row.id}>
                          <tr className="text-foreground/80">
                            <td className="px-2 py-1.5 font-mono">
                              {row.scene_season != null
                                ? `S${String(row.scene_season).padStart(2, '0')}E${String(row.scene_episode).padStart(2, '0')}`
                                : "—"}
                            </td>
                            <td className="px-2 py-1.5 font-mono">
                              {row.anidb_season != null
                                ? `S${String(row.anidb_season).padStart(2, '0')}E${String(row.anidb_episode).padStart(2, '0')}`
                                : "—"}
                            </td>
                            <td className="px-2 py-1.5 font-mono">
                              {row.target_season != null
                                ? `S${String(row.target_season).padStart(2, '0')}E${String(row.target_episode).padStart(2, '0')}`
                                : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              {row.locked === 1 && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 mr-2 uppercase tracking-wider">
                                  <LockIcon className="size-3" /> Fixed
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() => beginFix(row)}
                                disabled={busy === `row-${row.id}`}
                                className="text-muted-foreground hover:text-signal transition-colors font-mono text-[11px] uppercase tracking-wider disabled:opacity-50"
                              >
                                {busy === `row-${row.id}` ? <Loader2Icon className="size-3 animate-spin" /> : "Fix"}
                              </button>
                            </td>
                          </tr>
                          {fixRow === row.id && (
                            <tr className="bg-white/[0.02]">
                              <td colSpan={4} className="px-2 py-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">Provider S</span>
                                  <input
                                    type="number"
                                    value={fixSeason}
                                    onChange={e => setFixSeason(e.target.value)}
                                    className="w-16 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:border-signal/60"
                                  />
                                  <span className="text-xs text-muted-foreground">E</span>
                                  <input
                                    type="number"
                                    value={fixEpisode}
                                    onChange={e => setFixEpisode(e.target.value)}
                                    className="w-16 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:border-signal/60"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => applyFix(row)}
                                    disabled={busy === `row-${row.id}`}
                                    className="flex items-center gap-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 px-2 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:opacity-50"
                                  >
                                    {busy === `row-${row.id}` ? <Loader2Icon className="size-3 animate-spin" /> : <Check className="size-3" />}
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setFixRow(null)}
                                    className="text-muted-foreground hover:text-foreground font-mono text-[11px] uppercase tracking-wider"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!showFixTable && (
              <p className="text-xs text-muted-foreground">
                No mapping rows yet. Use <span className="text-foreground/80">Refresh</span> to sync from
                TheXem, or override the season/episode per-file in Manual Import.
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}