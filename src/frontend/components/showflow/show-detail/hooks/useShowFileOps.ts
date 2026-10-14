import * as React from "react";

import type { ShowSummary } from "@frontend/components/showflow/PosterCard";

import type { FlashStatus, OrganizePreview, RenamePreview } from "../types";

/**
 * Disk-side show operations: organise (preview → apply), rename folder
 * (preview → apply), rename series, rescan, refresh metadata and remove.
 * `reload` re-fetches the episode list (or the movie panel) afterwards.
 */
export function useShowFileOps(
  show: ShowSummary,
  flashStatus: FlashStatus,
  reload: () => void,
  opts: { onBack: () => void; onToggleExpand?: () => void },
) {
  const [organizing, setOrganizing] = React.useState(false);
  const [organizePreview, setOrganizePreview] = React.useState<OrganizePreview | null>(null);
  const [organizeApplying, setOrganizeApplying] = React.useState(false);
  const [renamingFolder, setRenamingFolder] = React.useState(false);
  const [renamePreview, setRenamePreview] = React.useState<RenamePreview | null>(null);
  const [renameSeriesOpen, setRenameSeriesOpen] = React.useState(false);
  const [renameSeriesTitle, setRenameSeriesTitle] = React.useState("");
  const [renamingSeries, setRenamingSeries] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  async function openOrganize() {
    setOrganizing(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/organize-preview`);
      if (!res.ok) throw new Error("Failed to load organize preview");
      const data = await res.json();
      setOrganizePreview({
        namingPattern: data.namingPattern ?? "",
        items: data.items ?? [],
        wouldChange: data.wouldChange ?? false,
      });
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to load organize preview.", false);
    } finally {
      setOrganizing(false);
    }
  }

  async function applyOrganize() {
    if (!organizePreview) return;
    setOrganizeApplying(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/organize`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to organize files");
      }
      const data = await res.json();
      const parts: string[] = [];
      if (data.moved > 0) parts.push(`Moved ${data.moved} file${data.moved !== 1 ? "s" : ""} into the show folder`);
      if (data.skipped > 0) parts.push(`${data.skipped} already correct`);
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      flashStatus(parts.length > 0 ? parts.join(", ") + "." : "No files to move.");
      setOrganizePreview(null);
      if (data.moved > 0) reload();
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to organize files.", false);
    } finally {
      setOrganizeApplying(false);
    }
  }

  async function openRenameFolder() {
    setRenamingFolder(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename-preview`);
      if (!res.ok) throw new Error("Failed to load rename preview");
      const data = await res.json();
      setRenamePreview({
        currentFolderPath: data.currentFolderPath,
        currentFolderName: data.currentFolderName,
        sanitizedTitle: data.sanitizedTitle,
        targetFolderPath: data.targetFolderPath,
        wouldChange: data.wouldChange,
        episodesAffected: (data.episodeImpact ?? []).filter((e: any) => e.wouldUpdate).length,
      });
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to load rename preview.", false);
    } finally {
      setRenamingFolder(false);
    }
  }

  async function applyRenameFolder() {
    if (!renamePreview) return;
    setRenamingFolder(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename-apply`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Rename failed");
      flashStatus(data.message ?? `Renamed folder to "${data.to}". ${data.episodesUpdated} episode path${data.episodesUpdated !== 1 ? "s" : ""} updated.`);
      setRenamePreview(null);
      // The show's root folder (library root) did not change — only the show's
      // own folder underneath it was renamed, so nothing to refresh here.
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to rename folder.", false);
    } finally {
      setRenamingFolder(false);
    }
  }

  function openRenameSeries() {
    setRenameSeriesTitle(show.title);
    setRenameSeriesOpen(true);
  }

  async function applyRenameSeries() {
    const title = renameSeriesTitle.trim();
    if (!title) return;
    setRenamingSeries(true);
    try {
      const res = await fetch(`/api/shows/${show.id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Rename failed");
      setRenameSeriesOpen(false);
      flashStatus(
        `Renamed to "${data.to}".` +
        (data.folderRenamed ? ` Folder moved (${data.episodesUpdated} episode path${data.episodesUpdated !== 1 ? "s" : ""} updated).` : "") +
        (data.folderError ? ` ${data.folderError}.` : ""),
        !data.folderError,
      );
      // Title + folder changed; the show list needs a refresh so the new
      // title/poster path is picked up.
      if (opts.onToggleExpand) opts.onToggleExpand();
      window.dispatchEvent(new CustomEvent("showflow-refresh-shows", { detail: { showId: show.id, title: data.to } }));
      reload();
    } catch (err: any) {
      flashStatus(err.message ?? "Failed to rename series.", false);
    } finally {
      setRenamingSeries(false);
    }
  }

  async function scanDir() {
    flashStatus("Scanning...");
    try {
      const res = await fetch(`/api/shows/${show.id}/scan`, { method: "POST" });
      if (!res.ok) throw new Error("Scan failed");
      reload();
      flashStatus("Scan complete.");
    } catch {
      flashStatus("Scan failed.", false);
    }
  }

  // Same endpoint the Metadata Sources dialog's per-provider "sync" uses.
  async function refreshMetadata() {
    setRefreshing(true);
    flashStatus("Refreshing metadata...");
    try {
      const res = await fetch(`/api/shows/${show.id}/sync`, { method: "POST" });
      if (!res.ok) throw new Error("Refresh failed");
      reload();
      flashStatus("Metadata refreshed.");
    } catch {
      flashStatus("Metadata refresh failed.", false);
    } finally {
      setRefreshing(false);
    }
  }

  async function removeShow() {
    setRemoving(true);
    try {
      const res = await fetch(`/api/shows/${show.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove show");
      setRemoveOpen(false);
      opts.onBack();
    } catch (err) {
      flashStatus(`Error removing show: ${err instanceof Error ? err.message : String(err)}`, false);
    } finally {
      setRemoving(false);
    }
  }

  return {
    organizing,
    organizePreview,
    setOrganizePreview,
    organizeApplying,
    openOrganize,
    applyOrganize,
    renamingFolder,
    renamePreview,
    setRenamePreview,
    openRenameFolder,
    applyRenameFolder,
    renameSeriesOpen,
    setRenameSeriesOpen,
    renameSeriesTitle,
    setRenameSeriesTitle,
    renamingSeries,
    openRenameSeries,
    applyRenameSeries,
    scanDir,
    refreshing,
    refreshMetadata,
    removeOpen,
    setRemoveOpen,
    removing,
    removeShow,
  };
}

export type ShowFileOps = ReturnType<typeof useShowFileOps>;
