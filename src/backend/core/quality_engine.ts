import { db } from '../db';
import type { ReasonCode } from './pipeline/reason_codes';
import type { MediaProbeInfo } from './media_probe';
import { isSampleFile } from './sample_filter';
import { matchTier, SOURCE_LABELS, type ReleaseSource } from './release_quality';
import {
  BUILTIN_TERMS, BEST_SOURCE_STEP, qualityLabel, qualityRank, releaseResolution, resolutionStep, scoreTerms,
  parseSource, type ResolvedTerm, type TermHit,
} from './quality_terms';
import { getProfileModel, resolveProfileTerms, type ProfileModel } from '../db/quality_model';

/**
 * Release scoring on the streamlined profile model (see core/quality_terms.ts):
 *
 *   reject  never-term matched / must-term missing / resolution outside
 *           min..target (or unknown and not allowed) / source skipped
 *   rank    = resolutionStep * 10 + sourceStep   (fixed source order)
 *   total   = rank * 1000 + termScore            (each term counts once)
 *
 * The old engine (custom formats + allow-list + tier cutoff) is frozen in
 * quality_engine_legacy.ts for the migration preview only.
 */

export interface ReleaseScore {
  rank: number;
  /** Term score (kept under the old name - callers/UI read formatScore). */
  formatScore: number;
  totalScore: number;
  /** Matching quality_definitions id when one exists (display/back-compat only). */
  qualityId?: string;
  /** Old tier-style label: "WEBDL-1080p", bare "1080p" when the source is unknown. */
  qualityName?: string;
  /** True if this release should never be grabbed under this profile. Callers must filter these out. */
  rejected: boolean;
  rejectReason?: string;
  /** Structured taxonomy code for rejectReason - see core/pipeline/reason_codes.ts. */
  rejectCode?: ReasonCode;
  /** Quality label + every built-in term the name carries + matched profile terms. */
  matchedTags: string[];
  /** Parsed vertical resolution (1080, 2160, ...) or null. */
  resolution?: number | null;
  /** Parsed source (remux, bluray, webdl, ...) or null when the name doesn't say. */
  source?: ReleaseSource | null;
  /** Per-term breakdown under this profile. */
  termHits?: TermHit[];
}

/** Why an incoming file is or isn't an upgrade over an existing one. */
export interface UpgradeExplanation {
  isUpgrade: boolean;
  /** upgrade | equal / worse score | incoming rejected by the profile | sample | upgrades off. */
  verdict: 'upgrade' | 'equal' | 'worse' | 'rejected' | 'sample' | 'upgrades_off';
  existing: ReleaseScore;
  newcomer: ReleaseScore;
  /** What the existing file's score came from: its probed media (+ release title) or just its filename. */
  existingBasis: 'probe' | 'filename';
  upgradesAllowed: boolean;
  profileName: string | null;
}

/** Profile + resolved terms, loaded once per scoring call. */
export interface LoadedProfile {
  model: ProfileModel | null;
  terms: ResolvedTerm[];
}

export function loadProfile(profileId: string): LoadedProfile {
  const model = getProfileModel(db, profileId);
  return { model, terms: model ? resolveProfileTerms(db, model) : [] };
}

function libraryTags(name: string): string[] {
  return BUILTIN_TERMS.filter(t => t.match.test(name)).map(t => t.label);
}

/** Score a name against an already-loaded profile. Pure apart from the tier-id lookup. */
export function scoreWithProfile(name: string, p: LoadedProfile, opts: { assumeBestSource?: boolean } = {}): ReleaseScore {
  const source = parseSource(name);
  const resolution = releaseResolution(name, source);
  const rank = qualityRank(resolution, source);
  const qualityName = qualityLabel(resolution, source);
  const tier = qualityName ? matchTier(name, db.listQualities() as any[]).tier : null;
  const qualityId = tier?.id;
  const terms = scoreTerms(name, p.terms);
  const matchedTags = [...new Set([
    ...(qualityName ? [qualityName] : []),
    ...terms.hits.filter(h => h.matched && h.weight !== 0).map(h => h.label),
    ...libraryTags(name),
  ])];
  const base = { rank, qualityId, qualityName, matchedTags, resolution, source, termHits: terms.hits };
  const reject = (rejectReason: string, rejectCode: ReasonCode): ReleaseScore =>
    ({ ...base, formatScore: -1, totalScore: -1, rejected: true, rejectReason, rejectCode });

  if (terms.neverMatched) return reject(`Never term matched: ${terms.neverMatched}`, 'FORBIDDEN_FORMAT_MATCHED');
  if (terms.missingMust.length) return reject(`Missing must-have term(s): ${terms.missingMust.join(', ')}`, 'MISSING_REQUIRED_FORMAT');

  const m = p.model;
  if (m) {
    if (resolution == null) {
      if (!m.allowUnknownResolution) return reject('Could not identify a resolution for this release', 'QUALITY_UNKNOWN');
    } else {
      const step = resolutionStep(resolution);
      if (m.minResolution != null && step < resolutionStep(m.minResolution)) return reject(`${resolution}p is below this profile's minimum (${m.minResolution}p)`, 'QUALITY_NOT_ALLOWED');
      if (m.targetResolution != null && step > resolutionStep(m.targetResolution)) return reject(`${resolution}p is above this profile's target (${m.targetResolution}p)`, 'QUALITY_NOT_ALLOWED');
    }
    if (source && m.skipSources.includes(source)) return reject(`${SOURCE_LABELS[source]} is skipped in this profile`, 'QUALITY_NOT_ALLOWED');
  }

  const compareRank = opts.assumeBestSource && !source && resolution != null
    ? resolutionStep(resolution) * 10 + BEST_SOURCE_STEP
    : rank;
  return { ...base, formatScore: terms.score, totalScore: compareRank * 1000 + terms.score, rejected: false };
}

export class QualityEngine {
  /** Parsed resolution/source and the rank they give, independent of any profile. */
  detectQuality(filename: string): { rank: number; qualityId?: string; qualityName?: string; resolution: number | null; source: ReleaseSource | null } {
    const source = parseSource(filename);
    const resolution = releaseResolution(filename, source);
    const qualityName = qualityLabel(resolution, source);
    const tier = qualityName ? matchTier(filename, db.listQualities() as any[]).tier : null;
    return { rank: qualityRank(resolution, source), qualityId: tier?.id, qualityName, resolution, source };
  }

  /** False when the profile has upgrades off: no upgrade search AND imports never replace a file. */
  upgradesAllowed(profileId: string): boolean {
    const m = getProfileModel(db, profileId);
    return m ? m.upgradesEnabled : true;
  }

  getReleaseScore(filename: string, profileId: string): ReleaseScore {
    return scoreWithProfile(filename, loadProfile(profileId));
  }

  /** Filename-vs-filename upgrade check. Never true when the profile has upgrades off. */
  shouldUpgrade(existingFilename: string, newFilename: string, profileId: string): boolean {
    return this.explainUpgrade(null, existingFilename, newFilename, profileId).isUpgrade;
  }

  /**
   * Media-aware upgrade decision for the blackhole import path: the stored
   * (renamed) file is scored from its probed media, with its original
   * release title supplying the source when it agrees on resolution.
   * Never true when the profile has upgrades off.
   */
  shouldUpgradeWithMedia(
    existingProbe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'> | null,
    existingFilename: string,
    newFilename: string,
    profileId: string,
    existingReleaseName?: string | null,
  ): boolean {
    return this.explainUpgrade(existingProbe, existingFilename, newFilename, profileId, existingReleaseName).isUpgrade;
  }

  /**
   * The upgrade decision WITH its reasoning: both scores, which basis the
   * existing file was scored on, and why it was (not) an upgrade. This is
   * the single implementation behind shouldUpgrade / shouldUpgradeWithMedia,
   * so Manual Import's explanation can never drift from the real decision.
   */
  explainUpgrade(
    existingProbe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'> | null,
    existingFilename: string,
    newFilename: string,
    profileId: string,
    existingReleaseName?: string | null,
  ): UpgradeExplanation {
    const p = loadProfile(profileId);
    const upgradesAllowed = p.model ? p.model.upgradesEnabled : true;
    const existing = existingProbe
      ? mergeProbeWithRelease(
          scoreFromMedia(existingProbe, p),
          existingReleaseName ? scoreWithProfile(existingReleaseName, p) : null,
        )
      : scoreWithProfile(existingFilename, p);
    const newcomer = scoreWithProfile(newFilename, p);
    const existingBasis: UpgradeExplanation['existingBasis'] = existingProbe ? 'probe' : 'filename';
    const base = { existing, newcomer, existingBasis, upgradesAllowed, profileName: p.model?.name ?? null };
    if (!upgradesAllowed) return { ...base, isUpgrade: false, verdict: 'upgrades_off' };
    if (newcomer.rejected) return { ...base, isUpgrade: false, verdict: 'rejected' };
    if (isSampleFile(newFilename)) return { ...base, isUpgrade: false, verdict: 'sample' };
    if (newcomer.totalScore > existing.totalScore) return { ...base, isUpgrade: true, verdict: 'upgrade' };
    return { ...base, isUpgrade: false, verdict: newcomer.totalScore === existing.totalScore ? 'equal' : 'worse' };
  }

  /**
   * Score a file from its probed media. A probe can't tell WEB-DL from Remux,
   * so the comparison total assumes the best source at that resolution (an
   * equal-resolution release can't upgrade it on source alone); rank and
   * qualityName stay the bare resolution for the cutoff check / UI.
   */
  getReleaseScoreFromMedia(
    probe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>,
    profileId: string,
  ): ReleaseScore {
    return scoreFromMedia(probe, loadProfile(profileId));
  }
}

/** Synthetic release name carrying what a probe can see (resolution, codec, HDR, audio). */
export function syntheticNameFromProbe(probe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>): string {
  const tags: string[] = [];
  const width = probe.video?.width ?? null;
  const height = probe.video?.height ?? null;
  const px = width != null && height != null ? width * height : null;
  if (px != null && px >= 7680 * 4320 * 0.9) tags.push('4320p');
  else if ((px != null && px >= 3840 * 2160 * 0.8) || (height ?? 0) >= 2000) tags.push('2160p');
  else if ((px != null && px >= 1920 * 1080 * 0.8) || (height ?? 0) >= 1000) tags.push('1080p');
  else if ((height ?? 0) >= 700) tags.push('720p');
  else if ((height ?? 0) > 0) tags.push('480p');

  const codec = (probe.video?.codec ?? '').toLowerCase();
  if (/265|hevc|h265|hvc1|hev1/.test(codec)) tags.push('H.265');
  if (/264|avc|h264/.test(codec)) tags.push('H.264');
  if (/av1|av01/.test(codec)) tags.push('AV1');
  if (probe.video?.hdr) tags.push('HDR');

  const audio = probe.audio?.[0]?.codec?.toLowerCase() ?? '';
  if (/truehd|mlp/.test(audio)) tags.push('TrueHD');
  if (/eac3|ec-?3/.test(audio)) tags.push('DDP');
  if (/aac|mp4a/.test(audio)) tags.push('AAC');
  if (/flac/.test(audio)) tags.push('FLAC');
  if (/atmos/.test(audio)) tags.push('Atmos');

  // HDR + heavily encoded content signals a remux/BD-grade release.
  const mbps = (probe.overallBitrate ?? 0) / 1_000_000;
  if (probe.video?.hdr && mbps >= 20) tags.push('Remux');
  return `Synthetic Release ${tags.join(' ')}`.trim();
}

export function scoreFromMedia(probe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>, p: LoadedProfile): ReleaseScore {
  return scoreWithProfile(syntheticNameFromProbe(probe), p, { assumeBestSource: true });
}

/**
 * Combine a probed file's score with its original release title's score.
 * When the title names a source at the same resolution the probe saw, use
 * the title's rank for the comparison total; the probe still supplies the
 * term score. Shared by the import check and the cutoff upgrade search.
 */
export function mergeProbeWithRelease(probed: ReleaseScore, release: ReleaseScore | null): ReleaseScore {
  if (!release || probed.rejected || !release.source || release.rank <= 0) return probed;
  const probedRes = probed.resolution ?? null;
  const releaseRes = release.resolution ?? null;
  if (probedRes == null || releaseRes == null || probedRes !== releaseRes) return probed;
  return {
    ...probed,
    rank: release.rank,
    qualityId: release.qualityId,
    qualityName: release.qualityName,
    source: release.source,
    totalScore: release.rank * 1000 + probed.formatScore,
  };
}

/** Human label for a parsed source ("webdl" -> "WEB-DL"). */
export function sourceLabel(source: ReleaseSource | null | undefined): string | null {
  return source ? SOURCE_LABELS[source] : null;
}

export const qualityEngine = new QualityEngine();
