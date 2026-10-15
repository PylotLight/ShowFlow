import * as React from "react";

import type { ShowSummary } from "@frontend/components/showflow/PosterCard";

import type { FlashStatus, FolderProfile, MoveDialogState, QualityProfile } from "../types";

/**
 * Per-show configuration: quality profile, series type, root folder (with
 * the optional "move existing files" step), episode-mapping health, learned
 * release delay and the optional monitor-new-episodes flag.
 */
export function useShowConfig(show: ShowSummary, flashStatus: FlashStatus) {
  const [profiles, setProfiles] = React.useState<QualityProfile[]>([]);
  const [profile, setProfile] = React.useState<string>(show.profile || "standard");
  const [folderProfiles, setFolderProfiles] = React.useState<FolderProfile[]>([]);
  const [rootFolderPath, setRootFolderPath] = React.useState<string | null>(null);
  const [rootFolderSaving, setRootFolderSaving] = React.useState(false);
  const [seriesType, setSeriesType] = React.useState<string>(show.seriesType ?? "standard");
  const [releaseDelayMinutes, setReleaseDelayMinutes] = React.useState<number | null>(null);
  const [mappingHealth, setMappingHealth] = React.useState<string>("none");
  // Only present once the backend ships the field; undefined hides the toggle.
  const [monitorNewEpisodes, setMonitorNewEpisodes] = React.useState<boolean | undefined>(undefined);
  const [moveDialog, setMoveDialog] = React.useState<MoveDialogState | null>(null);
  const [relocating, setRelocating] = React.useState(false);

  React.useEffect(() => {
    // Quality profiles (points-system: 1080p/h265/etc via custom formats) -
    // distinct from the show_profiles folder presets used at Add Show time.
    fetch("/api/profiles").then(r => r.json()).then(data => setProfiles(Array.isArray(data) ? data : [])).catch(() => setProfiles([]));
  }, []);

  React.useEffect(() => {
    // Root-folder presets ("Shows" vs "Anime" etc.) - only ever applied at
    // Add Show time previously, so surfacing + editing them here is what
    // lets an existing show move between categories after the fact.
    fetch("/api/show-profiles").then(r => r.json()).then(data => setFolderProfiles(Array.isArray(data) ? data : [])).catch(() => setFolderProfiles([]));
  }, []);

  React.useEffect(() => {
    setRootFolderPath(null);
    setMonitorNewEpisodes(undefined);
    fetch(`/api/shows/${show.id}`).then(r => r.json()).then(data => {
      const resolvedType = data.seriesType ?? data.config?.seriesType ?? (show.providerType === "anilist" ? "anime" : "standard");
      setSeriesType(resolvedType);
      setReleaseDelayMinutes(data.releaseDelayMinutes ?? null);
      if (data.rootFolderPath) setRootFolderPath(data.rootFolderPath);
      setMappingHealth(data.config?.episodeMapping?.health ?? "none");
      setMonitorNewEpisodes(typeof data.monitorNewEpisodes === "boolean" ? data.monitorNewEpisodes : undefined);
    }).catch(() => {});
  }, [show.id, show.providerType]);

  function findProfileForType(type: string) {
    if (!folderProfiles.length) return null;
    if (type === "anime") {
      return folderProfiles.find(fp =>
        fp.id.toLowerCase().includes("anime") || fp.name.toLowerCase().includes("anime")
      ) ?? folderProfiles[0];
    }
    return folderProfiles.find(fp =>
      !fp.id.toLowerCase().includes("anime") && !fp.name.toLowerCase().includes("anime")
    ) ?? folderProfiles[0];
  }

  React.useEffect(() => {
    if (rootFolderPath === null && seriesType && folderProfiles.length > 0) {
      const match = findProfileForType(seriesType);
      if (match) setRootFolderPath(match.root_folder_path);
    }
  }, [seriesType, folderProfiles.length]);

  const matchedFolderProfileId = React.useMemo(
    () => folderProfiles.find(fp => fp.root_folder_path === rootFolderPath)?.id ?? "",
    [folderProfiles, rootFolderPath],
  );

  async function changeProfile(next: string) {
    const prev = profile;
    setProfile(next);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: next }),
      });
      if (!res.ok) throw new Error("Failed to update profile");
    } catch {
      setProfile(prev);
      flashStatus("Failed to update quality profile.", false);
    }
  }

  function changeSeriesType(v: string) {
    const match = findProfileForType(v);
    const body: Record<string, any> = { seriesType: v };
    if (match && match.root_folder_path !== rootFolderPath) body.rootFolderPath = match.root_folder_path;
    setSeriesType(v);
    if (match && match.root_folder_path !== rootFolderPath) setRootFolderPath(match.root_folder_path);
    fetch(`/api/shows/${show.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.ok && flashStatus(`Type set to "${v}".`)).catch(() => flashStatus("Failed to update.", false));
  }

  function changeRootFolder(profileId: string) {
    const target = folderProfiles.find(fp => fp.id === profileId);
    if (!target) return;
    if (!rootFolderPath) {
      executeRootFolderChange(target);
      return;
    }
    setMoveDialog({ oldRoot: rootFolderPath, newRoot: target.root_folder_path, profileName: target.name, profileId: target.id });
  }

  async function executeRootFolderChange(target: FolderProfile) {
    const prevPath = rootFolderPath;
    setRootFolderPath(target.root_folder_path);
    setRootFolderSaving(true);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootFolderPath: target.root_folder_path }),
      });
      if (!res.ok) throw new Error("Failed to update root folder");
      flashStatus(`Root folder set to "${target.name}".`);
    } catch {
      setRootFolderPath(prevPath);
      flashStatus("Failed to update root folder.", false);
    } finally {
      setRootFolderSaving(false);
    }
  }

  async function relocateWithChange(target: FolderProfile, oldRoot: string) {
    setMoveDialog(null);
    setRootFolderPath(target.root_folder_path);
    setRootFolderSaving(true);
    setRelocating(true);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootFolderPath: target.root_folder_path }),
      });
      if (!res.ok) throw new Error("Failed to update root folder");
      const relocate = await fetch(`/api/shows/${show.id}/relocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newRootPath: target.root_folder_path }),
      });
      if (!relocate.ok) throw new Error("Failed to move files");
      const data = await relocate.json();
      flashStatus(`Moved ${data.moved} file${data.moved !== 1 ? "s" : ""} to "${target.name}"${data.failed > 0 ? `. ${data.failed} failed.` : "."}`);
    } catch {
      setRootFolderPath(oldRoot);
      flashStatus("Failed to update root folder.", false);
    } finally {
      setRootFolderSaving(false);
      setRelocating(false);
    }
  }

  function refreshMappingHealth() {
    fetch(`/api/shows/${show.id}`).then(r => r.json()).then(data => {
      setMappingHealth(data.config?.episodeMapping?.health ?? "none");
    }).catch(() => {});
  }

  async function changeMonitorNewEpisodes(next: boolean) {
    const prev = monitorNewEpisodes;
    setMonitorNewEpisodes(next);
    try {
      const res = await fetch(`/api/shows/${show.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monitorNewEpisodes: next }),
      });
      if (!res.ok) throw new Error("Failed to update");
      flashStatus(next ? "New episodes will be monitored." : "New episodes won't be monitored.");
    } catch {
      setMonitorNewEpisodes(prev);
      flashStatus("Failed to update monitoring.", false);
    }
  }

  return {
    profiles,
    profile,
    changeProfile,
    seriesType,
    changeSeriesType,
    folderProfiles,
    rootFolderPath,
    rootFolderSaving,
    matchedFolderProfileId,
    changeRootFolder,
    executeRootFolderChange,
    relocateWithChange,
    moveDialog,
    setMoveDialog,
    relocating,
    releaseDelayMinutes,
    mappingHealth,
    refreshMappingHealth,
    monitorNewEpisodes,
    changeMonitorNewEpisodes,
  };
}

export type ShowConfig = ReturnType<typeof useShowConfig>;
