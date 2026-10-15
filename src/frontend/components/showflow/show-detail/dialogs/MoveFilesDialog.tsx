import { Loader2Icon } from "lucide-react";
import * as React from "react";

import type { MoveDialogState } from "../types";

/** Asked when the root folder changes: physically move files, or just repoint. */
export function MoveFilesDialog({ state, relocating, onMoveFiles, onChangeOnly, onCancel }: {
  state: MoveDialogState;
  relocating: boolean;
  onMoveFiles: () => void;
  onChangeOnly: () => void;
  onCancel: () => void;
}) {
  return (
      <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} role="dialog" aria-modal="true" aria-labelledby="move-files-title">
        <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
          style={{ backdropFilter: "blur(16px)" }}>
          <h3 id="move-files-title" className="font-display text-lg font-semibold text-white/90">Move existing files?</h3>
          <p className="text-sm text-muted-foreground">
            Episodes are currently stored under <code className="text-foreground/80">{state.oldRoot}</code>.
            Moving to <code className="text-foreground/80">{state.newRoot}</code> will physically relocate them.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={relocating}
              onClick={onMoveFiles}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 flex-1 rounded-md bg-signal/15 text-signal hover:bg-signal/25 text-sm font-medium py-2 transition-colors disabled:opacity-50"
            >
              {relocating ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2Icon className="size-3.5 animate-spin" /> Moving...
                </span>
              ) : (
                "Move files"
              )}
            </button>
            <button
              type="button"
              onClick={onChangeOnly}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 flex-1 rounded-md border border-white/10 hover:bg-white/[0.04] text-sm text-muted-foreground hover:text-foreground py-2 transition-colors"
            >
              Change folder only
            </button>
            <button
              type="button"
              onClick={() => onCancel()}
              className="outline-none focus-visible:ring-2 focus-visible:ring-signal/70 text-muted-foreground hover:text-foreground text-sm py-2 px-3 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
  );
}
