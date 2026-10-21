import path from 'node:path';
import type { DatabaseManager } from '../db';
import type { EpisodeWithFileRow } from '../db/grabs';
import { qualityEngine, mergeProbeWithRelease, type ReleaseScore } from './quality_engine';
import { getProfileModel } from '../db/quality_model';
import { qualityLabel, qualityRank } from './quality_terms';
import { mediaFromStoredRow } from './media_probe';

/**
 * Cutoff upgrades ("upgrade until X", Sonarr's Cutoff Unmet).
 *
 * A profile with upgrades on keeps looking for something better until the
 * file reaches its "upgrade until" quality (resolution + optional source),
 * and optionally until its term score reaches `upgrade_until_score`. An
 * episode is "cutoff unmet" when its file is below that; the auto-grabber
 * runs a small, low-priority upgrade slice for those and RSS may grab an
 * upgrade straight off a feed. Upgrades off means off: no searches here and
 * the import path won't replace files either (QualityEngine.shouldUpgrade*).
 *
 * The existing file is scored the same way the import path judges it
 * (blackhole.ts shouldUpgradeWithMedia): from its probed media when we have
 * it, so a grab is only sent when the import would actually keep it.
 */

/** Upgrade-search backoff by consecutive misses: 6h, 1d, 3d, then weekly.
 *  Counted in episodes.upgrade_misses (not search_attempts, which carries the
 *  missing-episode streak from before the file existed); the timestamp is
 *  episodes.last_searched_at, which only drives the missing backoff while
 *  file_path is empty, so the two never mix. */
export const UPGRADE_BACKOFF_HOURS = [6, 24, 72, 168] as const;

/** Give-up defaults (config.upgradeGiveUpMisses / upgradeGiveUpAfterDays).
 *  5 misses = searches at 0, +6h, +1d, +3d, +7d: about 11 days, then stop. */
export const DEFAULT_UPGRADE_GIVE_UP_MISSES = 5;
export const DEFAULT_UPGRADE_GIVE_UP_DAYS = 90;

/** "Upgrade until" when a profile has upgrades on but no explicit until
 *  resolution: its target if that's 1080p or lower, else 1080p. The target is
 *  the profile's ceiling (what it's allowed to grab), not where upgrades
 *  should stop: allowing 2160p must not silently mean "chase 2160p for every
 *  1080p file", and an unrestricted ("any") target must not mean 4320p. */
export const DEFAULT_UPGRADE_UNTIL_RESOLUTION = 1080;
export function defaultUpgradeUntilResolution(targetResolution: number | null | undefined): number {
  return targetResolution != null && targetResolution > 0
    ? Math.min(targetResolution, DEFAULT_UPGRADE_UNTIL_RESOLUTION)
    : DEFAULT_UPGRADE_UNTIL_RESOLUTION;
}

export interface UpgradeGiveUpPolicy {
  /** Stop scheduled upgrade searches after this many misses in a row (0 = never). */
  misses: number;
  /** Don't run scheduled upgrade searches for episodes that aired more than this many days ago (0 = no limit). */
  days: number;
}

export function giveUpPolicy(config: { upgradeGiveUpMisses?: number; upgradeGiveUpAfterDays?: number } | null | undefined): UpgradeGiveUpPolicy {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    misses: n(config?.upgradeGiveUpMisses, DEFAULT_UPGRADE_GIVE_UP_MISSES),
    days: n(config?.upgradeGiveUpAfterDays, DEFAULT_UPGRADE_GIVE_UP_DAYS),
  };
}

/** Max upgrade searches per auto-grab cycle (after the missing batch). */
export const MAX_UPGRADES_PER_CYCLE = 3;

export interface CutoffTarget {
  profileId: string;
  profileName: string;
  /** Kept for callers that log it; the streamlined model has no tier row. */
  qualityId: string;
  rank: number;
  name: string;
  /** Also keep upgrading until the file's term score reaches this. */
  minTermScore?: number | null;
  /** True when the profile set no until resolution and the default applied. */
  defaulted?: boolean;
}

/** Identity of a cutoff for the give-up counter: a profile/cutoff change resets it. */
export function cutoffKey(c: Pick<CutoffTarget, 'profileId' | 'name' | 'minTermScore'>): string {
  return `${c.profileId}|${c.name}|${c.minTermScore ?? ''}`;
}

/** Resolve a show's quality profile id the same way GrabberService does. */
export function resolveShowProfileId(
  dbm: DatabaseManager,
  show: { library_type_id?: string | null; profile?: string | null },
): string {
  const libraryType = show.library_type_id ? dbm.getLibraryType(show.library_type_id) : null;
  return libraryType?.quality_profile_id ?? dbm.resolveProfileId(show.profile ?? null) ?? '';
}

/**
 * The profile's "upgrade until" target, or null when upgrades are off.
 * Until a source ("1080p WEB-DL") = that exact rank; until a bare resolution
 * = any source at that resolution. No until resolution =
 * defaultUpgradeUntilResolution(target): the target capped at 1080p (it used
 * to be the target itself, else the top resolution, so a profile allowing
 * 2160p - or "any" - chased 2160p/4320p for every 1080p file).
 */
export function getProfileCutoff(dbm: DatabaseManager, profileId: string): CutoffTarget | null {
  if (!profileId) return null;
  const m = getProfileModel(dbm, profileId);
  if (!m || !m.upgradesEnabled) return null;
  const defaulted = m.upgradeUntilResolution == null;
  const res = m.upgradeUntilResolution ?? defaultUpgradeUntilResolution(m.targetResolution);
  const src = m.upgradeUntilSource;
  const rank = src ? qualityRank(res, src) : qualityRank(res, 'sdtv'); // bare: lowest source step at that res
  const name = qualityLabel(res, src) ?? `${res}p`;
  return { profileId, profileName: m.name, qualityId: '', rank, name, minTermScore: m.upgradeUntilScore, defaulted };
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
  /** The file's term score, for a profile's score-based upgrade-until. */
  termScore?: number | null;
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
export function isCutoffMet(existing: ExistingQuality, cutoff: { rank: number; name: string; minTermScore?: number | null }): boolean {
  if (existing.rank <= 0) return true;
  if (!qualityMet(existing, cutoff)) return false;
  // Score-based upgrade-until: quality is there, keep going until the terms are too.
  if (cutoff.minTermScore != null && existing.termScore != null && existing.termScore < cutoff.minTermScore) return false;
  return true;
}

function qualityMet(existing: ExistingQuality, cutoff: { rank: number; name: string }): boolean {
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
      ? { rank: releaseScore.rank, qualityName: releaseScore.qualityName ?? null, termScore: probed.rejected ? null : probed.formatScore }
      : { rank: probed.rank, qualityName: probed.qualityName ?? null, termScore: probed.rejected ? null : probed.formatScore };
    // Same basis as the import check (shouldUpgradeWithMedia with the stored
    // release title): a known source at the probed resolution sets the bar,
    // otherwise the probe's assume-best-source total does.
    return { compareScore: scoreValue(mergeProbeWithRelease(probed, releaseScore)), quality, via: 'probe' };
  }

  const fileScore = scorer.byName(path.basename(filePath), profileId);
  if (releaseScore && releaseScore.rank > 0 && releaseScore.rank >= fileScore.rank) {
    // Unprobed but we know what was grabbed/imported: the renamed library
    // filename usually lost its tags, the release title didn't.
    return { compareScore: scoreValue(releaseScore), quality: { rank: releaseScore.rank, qualityName: releaseScore.qualityName ?? null, termScore: releaseScore.rejected ? null : releaseScore.formatScore }, via: 'release' };
  }
  return { compareScore: scoreValue(fileScore), quality: { rank: fileScore.rank, qualityName: fileScore.qualityName ?? null, termScore: fileScore.rejected ? null : fileScore.formatScore }, via: 'filename' };
}

/**
 * Upgrade misses that still count against `key` (the current cutoff). A
 * count recorded against another profile/cutoff no longer applies.
 */
export function effectiveUpgradeMisses(
  row: { upgrade_misses?: number | null; upgrade_cutoff_key?: string | null },
  key: string,
): number {
  return row.upgrade_cutoff_key === key ? Math.max(0, row.upgrade_misses ?? 0) : 0;
}

/** True when the episode's last upgrade search is old enough to search again. */
export function isOutsideUpgradeBackoff(
  row: { last_searched_at: string | null },
  misses: number,
  nowMs: number,
): boolean {
  if (!row.last_searched_at) return true;
  const last = Date.parse(row.last_searched_at);
  if (!Number.isFinite(last)) return true;
  const idx = Math.min(Math.max(misses, 1), UPGRADE_BACKOFF_HOURS.length) - 1;
  return nowMs - last >= UPGRADE_BACKOFF_HOURS[idx]! * 3_600_000;
}

/** Why scheduled upgrade searches stopped for an episode, or null if they haven't. */
export type GiveUpReason = 'misses' | 'aged';

export function upgradeGiveUpReason(
  row: { air_date?: string | null },
  misses: number,
  policy: UpgradeGiveUpPolicy,
  nowMs: number,
): GiveUpReason | null {
  if (policy.misses > 0 && misses >= policy.misses) return 'misses';
  if (policy.days > 0 && row.air_date) {
    const aired = Date.parse(row.air_date);
    if (Number.isFinite(aired) && nowMs - aired > policy.days * 86_400_000) return 'aged';
  }
  return null;
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
  /** Upgrade misses counted against the current cutoff. */
  upgradeMisses: number;
  /** cutoffKey() of the cutoff this row was judged against (record misses with it). */
  cutoffKey: string;
  airDate: string | null;
  /** Set when scheduled upgrade searches have given up on this episode. */
  givenUp: GiveUpReason | null;
}

/**
 * Every tracked auto-mode episode whose file is below its profile cutoff.
 * `cooldownIso` drops episodes with a grab in flight (pass a far-future
 * value to keep them, e.g. for the Wanted view); `applyBackoff` drops ones
 * searched too recently. Episodes the give-up policy has stopped searching
 * (too many misses, or aired too long ago) are dropped unless
 * `includeGivenUp` (RSS: still upgrade opportunistically; the per-profile
 * view: show them as given up). `profileId` limits to one profile.
 * Ordered never-searched first, then oldest search.
 */
export function listCutoffUnmetEpisodes(
  dbm: DatabaseManager,
  opts: {
    nowMs?: number; cooldownIso?: string; applyBackoff?: boolean; scorer?: Scorer;
    giveUp?: UpgradeGiveUpPolicy; includeGivenUp?: boolean; profileId?: string;
  } = {},
): CutoffUnmetEpisode[] {
  const policy = opts.giveUp ?? giveUpPolicy(null);
  const nowMs = opts.nowMs ?? Date.now();
  const rows = dbm.listEpisodesWithFiles(opts.cooldownIso ?? '9999-12-31T00:00:00.000Z');
  const profileByShow = new Map<string, string>();
  const cutoffByProfile = new Map<string, CutoffTarget | null>();
  const out: CutoffUnmetEpisode[] = [];

  for (const row of rows) {
    let profileId = profileByShow.get(row.show_id);
    if (profileId === undefined) {
      profileId = resolveShowProfileId(dbm, row);
      profileByShow.set(row.show_id, profileId);
    }
    if (opts.profileId != null && profileId !== opts.profileId) continue;
    let cutoff = cutoffByProfile.get(profileId);
    if (cutoff === undefined) {
      cutoff = getProfileCutoff(dbm, profileId);
      cutoffByProfile.set(profileId, cutoff);
    }
    if (!cutoff) continue;

    const key = cutoffKey(cutoff);
    const misses = effectiveUpgradeMisses(row, key);
    const givenUp = upgradeGiveUpReason(row, misses, policy, nowMs);
    if (givenUp && !opts.includeGivenUp) continue;
    if (opts.applyBackoff && !isOutsideUpgradeBackoff(row, misses, nowMs)) continue;

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
      upgradeMisses: misses,
      cutoffKey: key,
      airDate: row.air_date ?? null,
      givenUp,
    });
  }

  out.sort((a, b) => {
    if (!a.lastSearchedAt !== !b.lastSearchedAt) return a.lastSearchedAt ? 1 : -1;
    return (a.lastSearchedAt ?? '').localeCompare(b.lastSearchedAt ?? '')
      || a.showTitle.localeCompare(b.showTitle) || a.season - b.season || a.episode - b.episode;
  });
  return out;
}
