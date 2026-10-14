import type { EpisodeData, FileMedia } from "@frontend/components/showflow/EpisodeRow";

export interface SeasonStat {
  seasonNumber: number;
  episodeCount: number;
  trackedCount: number;
}

export interface SeasonWithEpisodes extends SeasonStat {
  episodes: EpisodeData[];
}

export interface QualityProfile {
  id: string;
  name: string;
}

/** Root-folder preset ("Shows" vs "Anime" etc.) from /api/show-profiles. */
export interface FolderProfile {
  id: string;
  name: string;
  root_folder_path: string;
}

export type EpisodeFilter = "all" | "available" | "missing";

// Which release search/grab is currently in flight - used to disable/spin
// the right button without a big lookup table. `season:{n}` covers a
// season-level auto-grab; `ep:{season}:{episode}` covers one episode;
// `movie` the film grab and `missing` the show-wide "search missing" run.
export type GrabTarget = string | null;

// What the ReleaseSearchDialog is currently showing - undefined episode
// means a season-level (pack) search.
export interface SearchTarget {
  season: number;
  episode?: number;
}

export interface MovieFileInfo {
  path: string;
  name?: string | null;
  originalName?: string | null;
  size: number | null;
  sourceKind: string | null;
  releaseTitle: string | null;
  indexerName: string | null;
  importedAt: string | null;
  media?: FileMedia | null;
}

export interface OrganizePreview {
  namingPattern: string;
  items: { season: number; episode: number; currentPath: string; targetPath: string; action: "correct" | "move" }[];
  wouldChange: boolean;
}

export interface RenamePreview {
  currentFolderPath: string;
  currentFolderName: string;
  sanitizedTitle: string;
  targetFolderPath: string;
  wouldChange: boolean;
  episodesAffected: number;
}

export interface MoveDialogState {
  oldRoot: string;
  newRoot: string;
  profileName: string;
  profileId: string;
}

export interface SeasonSection {
  season: SeasonStat;
  all: EpisodeData[];
  episodes: EpisodeData[];
}

export type FlashStatus = (text: string, ok?: boolean) => void;
