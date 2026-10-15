import { Loader2Icon } from "lucide-react";
import * as React from "react";

/** Edits the series title (folder + episode paths follow on the backend). */
export function RenameSeriesDialog({ title, onTitleChange, applying, onApply, onCancel }: {
  title: string;
  onTitleChange: (v: string) => void;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
      <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} role="dialog" aria-modal="true" aria-labelledby="rename-series-title">
        <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
          style={{ backdropFilter: "blur(16px)" }}>
          <h3 id="rename-series-title" className="font-display text-lg font-semibold text-white/90">Rename series</h3>
          <p className="text-xs text-muted-foreground -mt-2">
            Changes the series title everywhere: the library display name, episode naming, and the on-disk
            folder (which is renamed to match the new title, with episode paths updated). The old title stays
            registered as an alias so files already on disk keep matching.
          </p>
          <label className="block space-y-1.5">
            <span className="text-caption font-mono uppercase tracking-wider text-muted-foreground">Title</span>
            <input
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) onApply(); }}
              autoFocus
              className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-foreground outline-none focus:border-signal/50 focus-visible:ring-2 focus-visible:ring-signal/50"
            />
          </label>
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
              disabled={applying || !title.trim()}
              onClick={onApply}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
            >
              {applying ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2Icon className="size-3.5 animate-spin" /> Renaming...
                </span>
              ) : (
                "Rename Series"
              )}
            </button>
          </div>
        </div>
      </div>
  );
}
