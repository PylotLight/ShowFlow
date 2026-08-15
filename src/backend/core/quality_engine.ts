import { db } from '../db';
import type { ReasonCode } from './pipeline/reason_codes';

/** Common technical tags always extracted from filenames regardless of
 *  profile configuration. These keep the tag display comprehensive even
 *  when no matching custom format has been added to the profile yet.
 *
 *  Matching is by word-boundary regex rather than plain substring so that
 *  real-world release names parse correctly:
 *    - "H.265" / "H 265" / "h265" all read as HEVC (previously only
 *      "x265"/"hevc" matched, so "…AAC2.0 H.265" releases lost their codec)
 *    - "DV" doesn't trip on "DVD", "HDR" doesn't match mid-word hashes, and
 *      tags inside brackets/groups like "[WEB.1080p.AV1]" are still found.
 */
const COMMON_TAGS: { name: string; patterns: RegExp[] }[] = [
  // ---- HDR / vision ------------------------------------------------------
  { name: 'HDR10+', patterns: [/\bhdr10\+?\b/i, /\bhdr[ ._-]?10plus\b/i] },
  { name: 'DV', patterns: [/\bdolby[\s._-]?vision\b/i, /\bhdr(?:\s?[\d.]+)?\s?dv\b/i, /\bdv\b/i] },
  { name: 'HLG', patterns: [/\bhlg\b/i] },
  { name: 'HDR', patterns: [/\bhdr[\s._-]?(?:\d{2}[._]?)?\b/i] },
  // ---- Video codecs ------------------------------------------------------
  { name: 'H.265', patterns: [/\bh[\s._-]?265\b/i] },
  { name: 'x265', patterns: [/\bx26?5\b/i, /\bx265\b/i] },
  { name: 'HEVC', patterns: [/\bhevc\b/i] },
  { name: 'H.264', patterns: [/\bh[\s._-]?264\b/i] },
  { name: 'x264', patterns: [/\bx264\b/i] },
  { name: 'AV1', patterns: [/\bav1(?:\.[\d.]*)?\b/i, /\bav01\b/i] },
  { name: 'VP9', patterns: [/\bvp9\b/i] },
  { name: '10bit', patterns: [/\b10[\s._-]?bits?\b/i, /\b10bit\b/i] },
  // ---- Audio codecs ------------------------------------------------------
  { name: 'TrueHD', patterns: [/\btruehd\b/i] },
  { name: 'DTS', patterns: [/\bdts[\s._-]?hd(?:\sma)?\b/i, /\bdtsx\b/i, /\bdts[\s._-]?\d+(?:\.\d+)?\b/i, /\bdts\b/i] },
  { name: 'Atmos', patterns: [/\batmos\b/i] },
  { name: 'FLAC', patterns: [/\bflac\b/i] },
  { name: 'AAC', patterns: [/\baac(?:\d+(?:\.\d+)?)?\b/i] },
  { name: 'AC3', patterns: [/\bac-?3\b/i, /\bddp\b/i, /\beatmos\b/i] },
  // ---- Source types ------------------------------------------------------
  { name: 'Web-DL', patterns: [/\bweb[\s._-]?dl\b/i] },
  { name: 'WebRip', patterns: [/\bweb[\s._-]?rips?\b/i] },
  { name: 'BluRay', patterns: [/\bblu[\s._-]?rays?\b/i, /\bbdrip\b/i] },
  { name: 'HDTV', patterns: [/\bhdtv\b/i, /\bdsr\b/i, /\bdvb\b/i] },
  // ---- General -----------------------------------------------------------
  { name: 'Repack', patterns: [/\brepack\b/i] },
  { name: 'Proper', patterns: [/\bproper\b/i] },
  { name: 'Remux', patterns: [/\bremux\b/i] },
  { name: 'Internal', patterns: [/\binternal\b/i] },
  { name: 'Multi-Subs', patterns: [/\bmulti[\s._-]?(?:subs?|subtitle|language)\b/i] },
];

function scanCommonTags(filename: string): string[] {
  const matched: string[] = [];
  for (const tag of COMMON_TAGS) {
    if (tag.patterns.some(p => p.test(filename))) matched.push(tag.name);
  }
  return matched;
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
  /** Structured taxonomy code for rejectReason - see core/pipeline/reason_codes.ts. Callers that log to the pipeline event log should use this, not rejectReason, so the reason is filterable/groupable rather than free text. */
  rejectCode?: ReasonCode;
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
        if ((q.rank ?? 0) > bestRank) {
          bestRank = q.rank ?? 0;
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
        totalScore += f.score ?? 0;
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
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Forbidden format matched: ${formatResult.forbiddenName}`, rejectCode: 'FORBIDDEN_FORMAT_MATCHED', matchedTags };
    }

    if (formatResult.missingRequired.length > 0) {
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Missing required format(s): ${formatResult.missingRequired.join(', ')}`, rejectCode: 'MISSING_REQUIRED_FORMAT', matchedTags };
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
        rejectCode: qualityId ? 'QUALITY_NOT_ALLOWED' : 'QUALITY_UNKNOWN',
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
