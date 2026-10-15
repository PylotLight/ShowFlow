import { db } from '../db';
import { qualityEngine, sourceLabel, type FormatHit } from './quality_engine';
import { getProfileCutoff, isCutoffMet } from './cutoff';

/**
 * "Test a release name" breakdown for the Quality settings page: how the
 * engine parses a title and scores it under one profile, without grabbing.
 */
export interface ReleaseTestResult {
  name: string;
  profileId: string;
  profileName: string | null;
  resolution: number | null;
  source: string | null;
  tier: { id: string; name: string; rank: number } | null;
  /** How the tier was picked: exact / source-fallback / resolution / source-only / name / none. */
  tierVia: string;
  formats: FormatHit[];
  formatScore: number;
  totalScore: number;
  allowed: boolean;
  rejectReason: string | null;
  rejectCode: string | null;
  /** null when the profile has no cutoff (= no upgrade search). */
  cutoff: { name: string; rank: number; met: boolean } | null;
}

export function testReleaseName(name: string, profileId: string): ReleaseTestResult {
  const profile = db.getProfile(profileId);
  const detected = qualityEngine.detectQuality(name);
  const score = qualityEngine.getReleaseScore(name, profileId);
  const formats = qualityEngine.calculateFormatScore(name, profileId);
  const cutoff = getProfileCutoff(db, profileId);
  const tierName = score.qualityName ?? null;

  return {
    name,
    profileId,
    profileName: profile?.name ?? null,
    resolution: detected.resolution,
    source: sourceLabel(detected.source),
    tier: detected.qualityId && tierName ? { id: detected.qualityId, name: tierName, rank: detected.rank } : null,
    tierVia: detected.via,
    formats: formats.hits,
    formatScore: formats.isForbidden ? 0 : formats.score,
    totalScore: score.totalScore,
    allowed: !score.rejected,
    rejectReason: score.rejectReason ?? null,
    rejectCode: score.rejectCode ?? null,
    cutoff: cutoff
      ? { name: cutoff.name, rank: cutoff.rank, met: isCutoffMet({ rank: score.rank, qualityName: tierName }, cutoff) }
      : null,
  };
}
