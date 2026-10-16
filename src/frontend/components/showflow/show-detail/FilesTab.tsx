import { FolderArchive, FolderPen, FolderSearch, Loader2Icon, Wand2 } from "lucide-react";
import * as React from "react";

import { GlassPanel } from "@frontend/components/showflow/GlassPanel";
import { MediaBadges } from "@frontend/components/showflow/MediaBadges";
import { ActionRow } from "@frontend/components/ui/action-row";
import { formatFileSize, formatImportDate } from "@frontend/lib/airtime";

import { seasonLabel } from "./format";
import type { SeasonSection } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * What's on disk for this show, from the same episode payload the Episodes
 * tab uses (no extra endpoint), plus the file-level operations.
 */
export function FilesTab({ sections, loading, organizing, renamingFolder, onOrganize, onRenameFolder, onDedupe, onScan }: {
  sections: SeasonSection[];
  loading: boolean;
  organizing: boolean;
  renamingFolder: boolean;
  onOrganize: () => void;
  onRenameFolder: () => void;
  onDedupe: () => void;
  onScan: () => void;
}) {
  const withFiles = sections
    .map((s) => ({ season: s.season.seasonNumber, files: s.all.filter((e) => !!e.filePath) }))
    .filter((s) => s.files.length > 0);
  const count = withFiles.reduce((a, s) => a + s.files.length, 0);
  const totalBytes = withFiles.reduce((a, s) => a + s.files.reduce((b, e) => b + (e.file?.size ?? 0), 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <ActionRow
        lead={
          <span className="font-mono text-xs text-muted-foreground">
            {count} file{count !== 1 ? "s" : ""}{totalBytes > 0 ? ` · ${formatFileSize(totalBytes)}` : ""}
          </span>
        }
        primary="organise"
        menuLabel="More file actions"
        actions={[
          { id: "organise", label: "Organise", icon: Wand2, busy: organizing, onSelect: onOrganize, hint: "Rename episode files to your naming pattern (shows a preview first)" },
          { id: "rename-folder", label: "Rename folder", icon: FolderPen, busy: renamingFolder, onSelect: onRenameFolder, hint: "Match the show folder to the sanitized title" },
          { id: "dedupe", label: "Dedupe", icon: FolderArchive, onSelect: onDedupe, hint: "Find overlapping and duplicate files" },
          { id: "rescan", label: "Rescan", icon: FolderSearch, onSelect: onScan, hint: "Re-read the show folder on disk for new or removed files" },
        ]}
      />

      <GlassPanel className="overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 p-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading files...
          </div>
        ) : count === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">No episode files on disk yet.</p>
        ) : (
          withFiles.map(({ season, files }) => (
            <div key={season} className="border-b border-white/[0.04] last:border-0">
              <div className="px-4 pt-3 pb-1.5 font-display text-sm font-semibold tracking-wide text-white/90">{seasonLabel(season)}</div>
              <ul className="divide-y divide-white/[0.04]">
                {files.map((ep) => {
                  const name = ep.file?.name ?? ep.filePath!.split(/[\\/]/).pop();
                  return (
                    <li key={`${ep.season}-${ep.episode}`} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground w-16">S{pad(ep.season)}E{pad(ep.episode)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12px] text-white/85" title={ep.filePath}>{name}</div>
                        {ep.file?.releaseTitle && ep.file.releaseTitle !== name && (
                          <div className="truncate font-mono text-[11px] text-muted-foreground" title={ep.file.releaseTitle}>{ep.file.releaseTitle}</div>
                        )}
                      </div>
                      {/* Phones: badges, size and date share one meta line; sm+ they're columns. */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
                        <MediaBadges media={ep.file?.media} max={3} />
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground sm:w-20 sm:text-right">{formatFileSize(ep.file?.size)}</span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground sm:w-20 sm:text-right">{formatImportDate(ep.file?.importedAt ?? null)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </GlassPanel>
    </div>
  );
}
