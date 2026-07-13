import { db } from '../db';

/** Common technical tags always extracted from filenames regardless of
 *  profile configuration. These keep the tag display comprehensive even
 *  when no matching custom format has been added to the profile yet. */
const COMMON_TAGS: { name: string; patterns: string[] }[] = [
  { name: 'HDR', patterns: ['hdr'] },
  { name: 'DV', patterns: ['dolby vision', 'dolbyvision', 'dv'] },
  { name: 'HDR10+', patterns: ['hdr10+', 'hdr10plus'] },
  { name: 'HLG', patterns: ['hlg'] },
  { name: 'x265', patterns: ['x265'] },
  { name: 'x264', patterns: ['x264'] },
  { name: 'HEVC', patterns: ['hevc'] },
  { name: 'AV1', patterns: ['av1'] },
  { name: 'VP9', patterns: ['vp9'] },
  { name: '10bit', patterns: ['10bit', '10-bit'] },
  { name: 'TrueHD', patterns: ['truehd'] },
  { name: 'DTS', patterns: ['dts'] },
  { name: 'Atmos', patterns: ['atmos'] },
  { name: 'FLAC', patterns: ['flac'] },
  { name: 'AAC', patterns: ['aac'] },
  { name: 'Repack', patterns: ['repack'] },
  { name: 'Proper', patterns: ['proper'] },
  { name: 'Remux', patterns: ['remux'] },
  { name: 'Internal', patterns: ['internal'] },
];

function scanCommonTags(filename: string): string[] {
  const lower = filename.toLowerCase();
  return COMMON_TAGS
    .filter(t => t.patterns.some(p => lower.includes(p)))
    .map(t => t.name);
}

export interface ReleaseScore {
  rank: number;
  formatScore: number;
  totalScore: number;
  qualityId?: string;
  qualityName?: string;
  /** True if this release should never be grabbed under this profile
   * (forbidden format matched, a required format was missing, or its
   * quality isn't in the profile's allow-list). Callers must filter these
   * out rather than just deprioritizing them by score. */
  rejected: boolean;
  rejectReason?: string;
  /** All tags detected from the filename (qualities + matched formats) */
  matchedTags: string[];
}

export class QualityEngine {
  /**
   * Detects the quality of a release based on its filename.
   * Returns the rank and the quality ID if found.
   */
  detectQuality(filename: string): { rank: number; qualityId?: string; matchedQualities: string[] } {
    const qualities = db.listQualities();
    let bestRank = 0;
    let bestId: string | undefined;
    const matchedQualities: string[] = [];
    const lower = filename.toLowerCase();

    for (const q of qualities) {
      if (lower.includes(q.name.toLowerCase())) {
        matchedQualities.push(q.name);
        if (q.rank > bestRank) {
          bestRank = q.rank;
          bestId = q.id;
        }
      }
    }

    return { rank: bestRank, qualityId: bestId, matchedQualities };
  }

  /**
   * Whether `qualityId` is acceptable under this profile's allow-list.
   * A profile with no allow-list configured yet is unrestricted (matches
   * everything) rather than rejecting everything - that's what keeps
   * existing profiles working exactly as before this feature existed.
   */
  isQualityAllowed(qualityId: string | undefined, profileId: string): { allowed: boolean; hasRestriction: boolean } {
    const allowedQualities = db.getProfileQualities(profileId);
    if (allowedQualities.length === 0) return { allowed: true, hasRestriction: false };
    if (!qualityId) return { allowed: false, hasRestriction: true };
    return { allowed: allowedQualities.some((q: any) => q.id === qualityId), hasRestriction: true };
  }

  /**
   * Calculates the sum of scores for custom formats that match the filename
   * and are associated with the given profile.
   */
  calculateFormatScore(filename: string, profileId: string): { score: number; isForbidden: boolean; forbiddenName?: string; missingRequired: string[]; matchedFormats: string[] } {
    const formats = db.getProfileFormats(profileId);
    let totalScore = 0;
    const missingRequired: string[] = [];
    const matchedFormats: string[] = [];

    for (const f of formats) {
      const regex = new RegExp(f.regex, 'i');
      const matches = regex.test(filename);

      if (f.profile_format_type === 'forbidden' && matches) {
        return { score: 0, isForbidden: true, forbiddenName: f.name, missingRequired: [], matchedFormats: [] };
      }

      if (f.profile_format_type === 'required' && !matches) {
        missingRequired.push(f.name);
      }

      if (f.profile_format_type === 'bonus' && matches) {
        totalScore += f.score;
        matchedFormats.push(f.name);
      }
    }

    return {
      score: totalScore,
      isForbidden: false,
      missingRequired,
      matchedFormats,
    };
  }

  /**
   * Returns a comprehensive score for a release, or a rejected result if it
   * violates the profile (forbidden format, missing required format, or a
   * quality outside the profile's allow-list).
   */
  private resolveQualityName(qualityId: string | undefined): string | undefined {
    if (!qualityId) return undefined;
    const qualities = db.listQualities();
    const q = qualities.find((q: any) => q.id === qualityId);
    return q?.name ?? undefined;
  }

  getReleaseScore(filename: string, profileId: string): ReleaseScore {
    const { rank, qualityId, matchedQualities } = this.detectQuality(filename);
    const qualityName = this.resolveQualityName(qualityId);
    const formatResult = this.calculateFormatScore(filename, profileId);
    const matchedTags = [...new Set([...matchedQualities, ...formatResult.matchedFormats, ...scanCommonTags(filename)])];

    if (formatResult.isForbidden) {
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Forbidden format matched: ${formatResult.forbiddenName}`, matchedTags };
    }

    if (formatResult.missingRequired.length > 0) {
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Missing required format(s): ${formatResult.missingRequired.join(', ')}`, matchedTags };
    }

    const qualityCheck = this.isQualityAllowed(qualityId, profileId);
    if (!qualityCheck.allowed) {
      return {
        rank,
        formatScore: -1,
        totalScore: -1,
        qualityId,
        qualityName,
        rejected: true,
        rejectReason: qualityId ? 'Quality not in this profile\'s allow-list' : 'Could not identify a quality for this release',
        matchedTags,
      };
    }

    const totalScore = (rank * 1000) + formatResult.score;

    return {
      rank,
      formatScore: formatResult.score,
      totalScore,
      qualityId,
      qualityName,
      rejected: false,
      matchedTags,
    };
  }

  /**
   * Compares two files to determine if the new one is an upgrade.
   */
  shouldUpgrade(existingFilename: string, newFilename: string, profileId: string): boolean {
    const existing = this.getReleaseScore(existingFilename, profileId);
    const newcomer = this.getReleaseScore(newFilename, profileId);

    if (newcomer.rejected) return false;

    return newcomer.totalScore > existing.totalScore;
  }
}

export const qualityEngine = new QualityEngine();
