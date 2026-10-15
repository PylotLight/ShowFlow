import { db } from '../db';
import { loadProfile, scoreWithProfile, sourceLabel } from './quality_engine';
import { getProfileCutoff, isCutoffMet } from './cutoff';
import { qualityRank, releaseResolution, parseSource, type TermHit } from './quality_terms';

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
  /** Tier-style label ("WEBDL-1080p") and the rank resolution + source give. */
  quality: { name: string; rank: number } | null;
  /** Every profile term, matched or not, with the weight it adds. */
  terms: TermHit[];
  termScore: number;
  totalScore: number;
  allowed: boolean;
  rejectReason: string | null;
  rejectCode: string | null;
  /** null when the profile has upgrades off. */
  cutoff: { name: string; rank: number; met: boolean; minTermScore: number | null } | null;
  upgradesEnabled: boolean;
}

export function testReleaseName(name: string, profileId: string): ReleaseTestResult {
  const p = loadProfile(profileId);
  const score = scoreWithProfile(name, p);
  const source = parseSource(name);
  const resolution = releaseResolution(name, source);
  const cutoff = getProfileCutoff(db, profileId);
  const termScore = (score.termHits ?? []).filter(h => h.matched).reduce((a, h) => a + h.weight, 0);

  return {
    name,
    profileId,
    profileName: p.model?.name ?? null,
    resolution,
    source: sourceLabel(source),
    quality: score.qualityName ? { name: score.qualityName, rank: qualityRank(resolution, source) } : null,
    terms: score.termHits ?? [],
    termScore,
    totalScore: score.totalScore,
    allowed: !score.rejected,
    rejectReason: score.rejectReason ?? null,
    rejectCode: score.rejectCode ?? null,
    cutoff: cutoff
      ? {
          name: cutoff.name,
          rank: cutoff.rank,
          minTermScore: cutoff.minTermScore ?? null,
          met: isCutoffMet({ rank: score.rank, qualityName: score.qualityName ?? null, termScore }, cutoff),
        }
      : null,
    upgradesEnabled: p.model ? p.model.upgradesEnabled : true,
  };
}
