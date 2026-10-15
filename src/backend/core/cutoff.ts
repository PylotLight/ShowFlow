import path from 'node:path';
import type { DatabaseManager } from '../db';
import type { EpisodeWithFileRow } from '../db/grabs';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { mediaFromStoredRow } from './media_probe';

/**
 * Cutoff upgrades ("upgrade until cutoff", Sonarr's Cutoff Unmet).
 *
 * A quality profile's `cutoff_quality_id` is the quality at which ShowFlow
 * stops looking for something better. An episode is "cutoff unmet" when it
 * has a file on disk whose quality ranks below the cutoff; the auto-grabber
 * runs a small, low-priority upgrade slice for those and RSS may grab an
 * upgrade straight off a feed. Profiles with no cutoff never upgrade
 * automatically (there's no separate "allow upgrades" flag on profiles - a
 * cutoff IS the opt-in). Once the cutoff is met the episode drops out.
 *
 * The existing file is scored the same way the import path judges it
 * (blackhole.ts shouldUpgradeWithMedia): from its probed media when we have
 * it, so a grab is only sent when the import would actually keep it.
 *
 * Custom-format score cutoffs aren't a thing yet (profiles have no
 * cutoff_format_score) - only the quality cutoff is enforced.
 */

/** Upgrade-search backoff by consecutive misses: 6h, 1d, 3d, then weekly.
 *  Reuses episodes.last_searched_at / search_attempts - those only drive the
 *  missing-episode backoff while file_path is empty, so the two never mix. */
export const UPGRADE_BACKOFF_HOURS = [6, 24, 72, 168] as const;

/** Max upgrade searches per auto-grab cycle (after the missing batch). */
export const MAX_UPGRADES_PER_CYCLE = 3;

export interface CutoffTarget {
  profileId: string;
  profileName: string;
  qualityId: string;
  rank: number;
  name: string;
}

/** Resolve a show's quality profile id the same way GrabberService does. */
export function resolveShowProfileId(
  dbm: DatabaseManager,
  show: { library_type_id?: string | null; profile?: string | null },
): string {
  const libraryType = show.library_type_id ? dbm.getLibraryType(show.library_type_id) : null;
  return libraryType?.quality_profile_id ?? dbm.resolveProfileId(show.profile ?? null) ?? '';
}

/** The profile's cutoff quality, or null when the profile has none (= no upgrades). */
export function getProfileCutoff(dbm: DatabaseManager, profileId: string): CutoffTarget | null {
  if (!profileId) return null;
  const profile = dbm.getProfile(profileId);
  if (!profile?.cutoff_quality_id) return null;
  const q = dbm.getQuality(profile.cutoff_quality_id);
  if (!q) return null;
  return { profileId, profileName: profile.name, qualityId: q.id, rank: q.rank ?? 0, name: q.name };
}

/** Vertical resolution a quality name implies ("WEBDL-1080p" -> 1080), or null. */
export function resolutionOf(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /(\d{3,4})p\b/i.exec(name);
  if (m) return Number(m[1]);
  if (/\b(?:8k|4320)\b/i.test(name)) return 4320;
  if (/\b(?:4k|uhd)\b/i.test(name)) return 2160;
  if (/\b(?:sdtv|dvd)\b/i.test(name)) return 480;
  return null;
}

/** "1080p" / "2160p" with no source prefix - what a probed file scores as. */
function isBareResolution(name: string | null | undefined): boolean {
  return !!name && /^\s*\d{3,4}p\s*$/i.test(name);
}

export interface ExistingQuality {
  rank: number;
  qualityName?: string | null;
}

/**
 * Whether `existing` already satisfies the cutoff.
 *
 *  - rank >= cutoff rank: met.
 *  - unknown quality (rank 0 - no probe, renamed file, no release title):
 *    treated as met. Chasing an unidentifiable file would search forever.
 *  - a bare resolution (from a probe, which can't see WEB-DL vs WEBRip) at or
 *    above the cutoff's resolution: met. Otherwise a probed 1080p file under a
 *    "WEBDL-1080p" cutoff would never count as done.
 */
export function isCutoffMet(existing: ExistingQuality, cutoff: { rank: number; name: string }): boolean {
  if (existing.rank <= 0) return true;
  if (existing.rank >= cutoff.rank) return true;
  const have = resolutionOf(existing.qualityName);
  const want = resolutionOf(cutoff.name);
  if (have != null && want != null) {
    if (have > want) return true;
    if (have === want && isBareResolution(existing.qualityName)) return true;
  }
  return false;
}

export interface ExistingFileScore {
  /** What a new release must strictly beat (same basis as the import check). */
  compareScore: number;
  /** Best-informed quality of the file, for the cutoff check / display. */
  quality: ExistingQuality;
  via: 'probe' | 'release' | 'filename';
}

export interface Scorer {
  byName(name: string, profileId: string): ReleaseScore;
  byMedia(probe: NonNullable<ReturnType<typeof mediaFromStoredRow>>, profileId: string): ReleaseScore;
}

export const defaultScorer: Scorer = {
  byName: (name, profileId) => qualityEngine.getReleaseScore(name, profileId),
  byMedia: (probe, profileId) => qualityEngine.getReleaseScoreFromMedia(probe, profileId),
};

function scoreValue(s: ReleaseScore): number {
  // A file the profile now rejects still has a quality; rank it so any
  // acceptable release beats it but the comparison stays meaningful.
  return s.rejected ? s.rank * 1000 - 1 : s.totalScore;
}

/**
 * Score the file currently stored for an episode.
 *
 * Comparison basis mirrors the blackhole import: probed media when the
 * episode_files row has it, else the filename. The *quality* used for the
 * cutoff check prefers the original release title (it knows WEB-DL vs
 * WEBRip) when it agrees with the probe's resolution.
 */
export function scoreExistingEpisodeFile(
  dbm: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
  filePath: string,
  profileId: string,
  scorer: Scorer = defaultScorer,
): ExistingFileScore {
  const row = (() => { try { return dbm.getCurrentEpisodeFile(showId, season, episode); } catch { return null; } })();
  const probe = row ? mediaFromStoredRow(row) : null;
  const releaseName = row?.release_title || row?.original_name || null;
  const releaseScore = releaseName ? scorer.byName(releaseName, profileId) : null;

  if (probe) {
    const probed = scorer.byMedia(probe, profileId);
    const probedRes = resolutionOf(probed.qualityName);
    const releaseRes = resolutionOf(releaseScore?.qualityName);
    const quality = releaseScore && releaseScore.rank > 0 && releaseRes != null && releaseRes === probedRes
      ? { rank: releaseScore.rank, qualityName: releaseScore.qualityName ?? null }
      : { rank: probed.rank, qualityName: probed.qualityName ?? null };
    return { compareScore: scoreValue(probed), quality, via: 'probe' };
  }

  const fileScore = scorer.byName(path.basename(filePath), profileId);
  if (releaseScore && releaseScore.rank > 0 && releaseScore.rank >= fileScore.rank) {
    // Unprobed but we know what was grabbed/imported: the renamed library
    // filename usually lost its tags, the release title didn't.
    return { compareScore: scoreValue(releaseScore), quality: { rank: releaseScore.rank, qualityName: releaseScore.qualityName ?? null }, via: 'release' };
  }
  return { compareScore: scoreValue(fileScore), quality: { rank: fileScore.rank, qualityName: fileScore.qualityName ?? null }, via: 'filename' };
}

/** True when the episode's last upgrade search is old enough to search again. */
export function isOutsideUpgradeBackoff(
  row: Pick<EpisodeWithFileRow, 'last_searched_at' | 'search_attempts'>,
  nowMs: number,
): boolean {
  if (!row.last_searched_at) return true;
  const last = Date.parse(row.last_searched_at);
  if (!Number.isFinite(last)) return true;
  const idx = Math.min(Math.max(row.search_attempts, 1), UPGRADE_BACKOFF_HOURS.length) - 1;
  return nowMs - last >= UPGRADE_BACKOFF_HOURS[idx]! * 3_600_000;
}

export interface CutoffUnmetEpisode {
  showId: string;
  showTitle: string;
  seriesType: string | null;
  profile: string | null;
  libraryTypeId: string | null;
  season: number;
  episode: number;
  filePath: string;
  profileId: string;
  profileName: string;
  cutoffName: string;
  currentQuality: string | null;
  existingScore: number;
  lastSearchedAt: string | null;
  searchAttempts: number;
}

/**
 * Every tracked auto-mode episode whose file is below its profile cutoff.
 * `cooldownIso` drops episodes with a grab in flight (pass a far-future
 * value to keep them, e.g. for the Wanted view); `applyBackoff` drops ones
 * searched too recently. Ordered never-searched first, then oldest search.
 */
export function listCutoffUnmetEpisodes(
  dbm: DatabaseManager,
  opts: { nowMs?: number; cooldownIso?: string; applyBackoff?: boolean; scorer?: Scorer } = {},
): CutoffUnmetEpisode[] {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = dbm.listEpisodesWithFiles(opts.cooldownIso ?? '9999-12-31T00:00:00.000Z');
  const profileByShow = new Map<string, string>();
  const cutoffByProfile = new Map<string, CutoffTarget | null>();
  const out: CutoffUnmetEpisode[] = [];

  for (const row of rows) {
    if (opts.applyBackoff && !isOutsideUpgradeBackoff(row, nowMs)) continue;
    let profileId = profileByShow.get(row.show_id);
    if (profileId === undefined) {
      profileId = resolveShowProfileId(dbm, row);
      profileByShow.set(row.show_id, profileId);
    }
    let cutoff = cutoffByProfile.get(profileId);
    if (cutoff === undefined) {
      cutoff = getProfileCutoff(dbm, profileId);
      cutoffByProfile.set(profileId, cutoff);
    }
    if (!cutoff) continue;

    const existing = scoreExistingEpisodeFile(dbm, row.show_id, row.season_number, row.episode_number, row.file_path, profileId, opts.scorer);
    if (isCutoffMet(existing.quality, cutoff)) continue;

    out.push({
      showId: row.show_id,
      showTitle: row.show_title,
      seriesType: row.series_type,
      profile: row.profile,
      libraryTypeId: row.library_type_id,
      season: row.season_number,
      episode: row.episode_number,
      filePath: row.file_path,
      profileId,
      profileName: cutoff.profileName,
      cutoffName: cutoff.name,
      currentQuality: existing.quality.qualityName ?? null,
      existingScore: existing.compareScore,
      lastSearchedAt: row.last_searched_at,
      searchAttempts: row.search_attempts,
    });
  }

  out.sort((a, b) => {
    if (!a.lastSearchedAt !== !b.lastSearchedAt) return a.lastSearchedAt ? 1 : -1;
    return (a.lastSearchedAt ?? '').localeCompare(b.lastSearchedAt ?? '')
      || a.showTitle.localeCompare(b.showTitle) || a.season - b.season || a.episode - b.episode;
  });
  return out;
}
