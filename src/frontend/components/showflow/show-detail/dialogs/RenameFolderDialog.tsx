import { Loader2Icon } from "lucide-react";
import * as React from "react";

import type { RenamePreview } from "../types";

/** Confirms renaming the on-disk show folder to the sanitized title. */
export function RenameFolderDialog({ preview, applying, onApply, onCancel }: {
  preview: RenamePreview;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
      <div className="fixed inset-0 z-50 grid place-items-center p-4" style={{ background: "rgba(0,0,0,.6)" }} role="dialog" aria-modal="true" aria-labelledby="rename-folder-title">
        <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#15181f] shadow-2xl p-6 space-y-4"
          style={{ backdropFilter: "blur(16px)" }}>
          <h3 id="rename-folder-title" className="font-display text-lg font-semibold text-white/90">Rename show folder?</h3>
          <p className="text-xs text-muted-foreground -mt-2">
            The folder on disk will be renamed to match the show's current title. Episode file paths are updated automatically.
          </p>

          <div className="space-y-2 text-xs">
            <div>
              <div className="flex items-center gap-2">
                <span className="uppercase tracking-wider font-mono text-muted-foreground text-[11px] w-11 shrink-0">From</span>
                <code className="text-foreground/85 break-all">{preview.currentFolderName}</code>
              </div>
              <p className="text-[11px] font-mono text-muted-foreground mt-0.5 break-all pl-[52px]">
                {preview.currentFolderPath}
              </p>
            </div>
            <div className="text-muted-foreground pl-[52px] font-mono text-[11px]">↓ rename to</div>
            <div>
              <div className="flex items-center gap-2">
                <span className="uppercase tracking-wider font-mono text-signal text-[11px] w-11 shrink-0">To</span>
                <code className="text-signal break-all">{preview.sanitizedTitle}</code>
              </div>
              <p className="text-[11px] font-mono text-muted-foreground mt-0.5 break-all pl-[52px]">
                {preview.targetFolderPath}
              </p>
            </div>
          </div>

          {!preview.wouldChange ? (
            <p className="text-xs text-muted-foreground">
              Folder already has the correct name — nothing to do.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {preview.episodesAffected > 0
                  ? `${preview.episodesAffected} episode${preview.episodesAffected !== 1 ? "s" : ""} inside this folder will${preview.episodesAffected !== 1 ? " " : ""}have its file path updated automatically.`
                  : "No episode paths need updating."}
              </p>
              <p className="text-[11px] text-amber-400/80 border border-amber-500/30 rounded px-2 py-1.5 bg-amber-500/5">
                Plex/Jellyfin libraries that point at the old folder path will need a library refresh after the rename.
              </p>
            </>
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
                  <Loader2Icon className="size-3.5 animate-spin" /> Renaming...
                </span>
              ) : (
                "Rename Folder"
              )}
            </button>
          </div>
        </div>
      </div>
  );
}
