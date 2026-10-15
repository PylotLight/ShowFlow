import { BanIcon, ChevronDownIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { confirmDialog, type ConfirmOptions } from "@frontend/components/ui/confirm";
import { formatImportDate } from "@frontend/lib/airtime";
import { notify } from "@frontend/lib/toast";
import { usePolling, setIfChanged } from "@frontend/lib/usePolling";
import { cn } from "@frontend/lib/utils";

/**
 * Failed downloads + release blocklist. Self-contained so it can be mounted
 * from History (or the Activity page) with a single line.
 *   - Grabs tab: recent grabs with lifecycle status and a
 *     "Mark failed & blocklist" action (POST /api/grabs/:id/fail).
 *   - Blocklist tab: blocklisted releases, remove one or clear all
 *     (DELETE /api/blocklist[/:id]).
 */

interface GrabItem {
  id: number;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  releaseTitle: string;
  indexerName: string | null;
  status: "grabbed" | "downloading" | "completed" | "imported" | "failed";
  failureReason: string | null;
  grabbedAt: string | null;
}

interface BlockItem {
  id: number;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumbers: number[];
  releaseTitle: string;
  indexerName: string | null;
  reason: string | null;
  createdAt: string;
}

const STATUS_STYLE: Record<GrabItem["status"], string> = {
  grabbed: "text-signal border-signal/40",
  downloading: "text-sky-300 border-sky-300/40",
  completed: "text-emerald-300 border-emerald-300/40",
  imported: "text-emerald-400 border-emerald-400/40",
  failed: "text-red-300 border-red-300/40",
};

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60";

function epLabel(season: number | null, episodes: number[]): string | null {
  if (season == null) return null;
  const s = `S${String(season).padStart(2, "0")}`;
  if (episodes.length === 0) return s;
  return s + episodes.map((e) => `E${String(e).padStart(2, "0")}`).join("");
}

export function BlocklistPanel() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<"grabs" | "blocklist">("grabs");
  const [grabs, setGrabs] = React.useState<GrabItem[]>([]);
  const [blocks, setBlocks] = React.useState<BlockItem[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [g, b] = await Promise.all([
        fetch("/api/grabs?limit=40").then((r) => (r.ok ? r.json() : { items: [] })),
        fetch("/api/blocklist").then((r) => (r.ok ? r.json() : { items: [] })),
      ]);
      setIfChanged(setGrabs)(g.items ?? []);
      setIfChanged(setBlocks)(b.items ?? []);
    } catch {
      // transient; next poll retries
    }
  }, []);

  usePolling(load, 30_000);

  async function act(key: string, url: string, method: "POST" | "DELETE", confirm: ConfirmOptions, done: string) {
    if (!(await confirmDialog(confirm))) return;
    setBusy(key);
    try {
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`);
      notify(true, done);
      await load();
    } catch (e) {
      notify(false, "Blocklist action failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const failedCount = grabs.filter((g) => g.status === "failed").length;

  return (
    <GlassPanel className="flex flex-col overflow-hidden shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn("flex items-center gap-2 px-5 py-3 text-left hover:bg-white/[0.02]", focusRing)}
      >
        <BanIcon className="size-4 text-red-300 shrink-0" />
        <span className="font-display text-base font-bold text-white">Failed downloads &amp; blocklist</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          <span className="text-white font-semibold">{failedCount}</span> failed ·{" "}
          <span className="text-white font-semibold">{blocks.length}</span> blocklisted
        </span>
        <ChevronDownIcon className={cn("size-4 text-white/70 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-white/5">
          <div className="flex items-center gap-1 px-4 pt-2" role="tablist">
            {(["grabs", "blocklist"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-all",
                  focusRing,
                  tab === t
                    ? "bg-signal/15 text-signal font-semibold"
                    : "text-muted-foreground hover:text-foreground bg-white/[0.03] hover:bg-white/[0.06]",
                )}
              >
                {t === "grabs" ? "Recent grabs" : `Blocklist (${blocks.length})`}
              </button>
            ))}
            {tab === "blocklist" && blocks.length > 0 && (
              <button
                onClick={() => act("clear", "/api/blocklist", "DELETE",
                  { title: `Clear all ${blocks.length} blocklisted release${blocks.length === 1 ? "" : "s"}?`, description: "They can be grabbed again on the next search.", confirmLabel: "Clear all", destructive: true },
                  "Blocklist cleared")}
                disabled={busy === "clear"}
                className={cn(
                  "ml-auto rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide border border-white/10 text-white/70 hover:text-white hover:bg-white/[0.06]",
                  focusRing,
                )}
              >
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto px-3 py-2 space-y-0.5">
            {tab === "grabs" ? (
              grabs.length === 0 ? (
                <div className="py-8 text-center font-mono text-xs text-muted-foreground">NO GRABS RECORDED YET.</div>
              ) : (
                grabs.map((g) => {
                  const key = `fail:${g.id}`;
                  const ep = epLabel(g.seasonNumber, g.episodeNumber != null ? [g.episodeNumber] : []);
                  const canFail = g.status !== "failed" && g.status !== "imported";
                  return (
                    <div key={g.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
                      <span className={cn("rounded-full border px-1.5 py-px font-mono text-[11px] font-bold uppercase tracking-wide shrink-0", STATUS_STYLE[g.status] ?? "text-white/70 border-white/10")}>
                        {g.status}
                      </span>
                      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5">
                        {g.showTitle && <span className="text-sm font-semibold text-white/85 line-clamp-1">{g.showTitle}</span>}
                        {ep && <span className="text-[11px] font-mono text-white/60 shrink-0">{ep}</span>}
                        <span title={g.releaseTitle} className="text-[11px] font-mono text-white/60 break-all line-clamp-1">{g.releaseTitle}</span>
                        {g.failureReason && <span title={g.failureReason} className="text-[11px] text-red-300 line-clamp-1">{g.failureReason}</span>}
                      </div>
                      {g.grabbedAt && <span className="text-[11px] font-mono text-white/60 shrink-0">{formatImportDate(g.grabbedAt)}</span>}
                      {canFail && (
                        <button
                          onClick={() => act(key, `/api/grabs/${g.id}/fail`, "POST",
                            { title: "Mark failed & blocklist?", description: g.releaseTitle, confirmLabel: "Mark failed", destructive: true },
                            "Marked failed and blocklisted, re-searching")}
                          disabled={busy === key}
                          aria-label={`Mark ${g.releaseTitle} failed and blocklist it`}
                          className={cn(
                            "flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide text-white/70 hover:text-red-200 hover:border-red-300/50",
                            focusRing,
                          )}
                        >
                          <XCircleIcon className="size-3.5" />
                          Mark failed &amp; blocklist
                        </button>
                      )}
                    </div>
                  );
                })
              )
            ) : blocks.length === 0 ? (
              <div className="py-8 text-center font-mono text-xs text-muted-foreground">BLOCKLIST IS EMPTY.</div>
            ) : (
              blocks.map((b) => {
                const key = `rm:${b.id}`;
                const ep = epLabel(b.seasonNumber, b.episodeNumbers);
                return (
                  <div key={b.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
                    <BanIcon className="size-4 text-red-300 shrink-0" />
                    <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5">
                      {b.showTitle && <span className="text-sm font-semibold text-white/85 line-clamp-1">{b.showTitle}</span>}
                      {ep && <span className="text-[11px] font-mono text-white/60 shrink-0">{ep}</span>}
                      <span title={b.releaseTitle} className="text-[11px] font-mono text-white/60 break-all line-clamp-1">{b.releaseTitle}</span>
                      {b.reason && <span title={b.reason} className="text-[11px] text-red-300 line-clamp-1">{b.reason}</span>}
                    </div>
                    {b.indexerName && (
                      <span className="rounded-full bg-white/[0.04] px-1.5 py-px font-mono text-[11px] font-bold uppercase tracking-wide text-white/60 border border-white/10 max-w-[120px] truncate">
                        {b.indexerName}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-white/60 shrink-0">{formatImportDate(b.createdAt)}</span>
                    <button
                      onClick={() => act(key, `/api/blocklist/${b.id}`, "DELETE",
                        { title: "Remove from blocklist?", description: b.releaseTitle, confirmLabel: "Remove" },
                        "Removed from blocklist")}
                      disabled={busy === key}
                      aria-label={`Remove ${b.releaseTitle} from the blocklist`}
                      title="Remove from blocklist"
                      className={cn(
                        "flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-1 text-white/70 hover:text-white hover:bg-white/[0.06]",
                        focusRing,
                      )}
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </GlassPanel>
  );
}
