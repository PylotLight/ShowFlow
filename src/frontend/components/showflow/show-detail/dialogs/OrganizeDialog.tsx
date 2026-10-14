import { Loader2Icon } from "lucide-react";
import * as React from "react";

import type { OrganizePreview } from "../types";

/** Preview of where each episode file would move; Move Files applies it. */
export function OrganizeDialog({ preview, applying, onApply, onCancel }: {
  preview: OrganizePreview;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const moves = preview.items.filter(i => i.action === "move").length;
  return (
      <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} role="dialog" aria-modal="true" aria-labelledby="organize-title">
        <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
          style={{ backdropFilter: "blur(16px)" }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="organize-title" className="font-display text-lg font-semibold text-white/90">Organize episodes?</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Files will be moved into the show's proper folder structure with your naming pattern. All paths relative to the show's library root.
              </p>
            </div>
            <span className="shrink-0 rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-white/60">
              {moves} move{moves === 1 ? '' : 's'}
            </span>
          </div>

          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1">Naming pattern</div>
            <code className="text-signal text-xs break-all">{preview.namingPattern}</code>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-white/10 bg-black/20 divide-y divide-white/[0.04]">
            {preview.items.length === 0 && (
              <p className="px-3 py-3 text-xs text-muted-foreground">No episode files on disk to organize.</p>
            )}
            {preview.items.map((item, idx) => {
              const move = item.action === 'move';
              return (
                <div key={idx} className="px-3 py-2.5 text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground shrink-0">S{item.season}E{item.episode}</span>
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${move ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                      {move ? "move" : "correct"}
                    </span>
                  </div>
                  {move && (
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      <div className="space-y-0.5">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">From</div>
                        <div className="text-muted-foreground break-all font-mono text-[11px] leading-relaxed">{item.currentPath}</div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">To</div>
                        <div className="text-signal break-all font-mono text-[11px] leading-relaxed">{item.targetPath}</div>
                      </div>
                    </div>
                  )}
                  {!move && (
                    <div className="text-muted-foreground break-all font-mono text-[11px] leading-relaxed">{item.currentPath}</div>
                  )}
                </div>
              );
            })}
          </div>

          {!preview.wouldChange ? (
            <p className="text-xs text-muted-foreground">
              All files already sit at their target paths — nothing to do.
            </p>
          ) : (
            <p className="text-[11px] text-amber-400/80 border border-amber-500/30 rounded px-2 py-1.5 bg-amber-500/5">
              Plex/Jellyfin libraries will need a scan after the move.
            </p>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => onCancel()}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 flex-1 rounded-md border border-white/10 text-muted-foreground text-sm font-medium py-2 hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={applying || !preview.wouldChange}
              onClick={onApply}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
            >
              {applying ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2Icon className="size-3.5 animate-spin" /> Organizing...
                </span>
              ) : (
                "Move Files"
              )}
            </button>
          </div>
        </div>
      </div>
  );
}
