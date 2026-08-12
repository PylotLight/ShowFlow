import { db } from '../db';
import type { ReasonCode } from './pipeline/reason_codes';

/**
 * Known technical "format families" - a single canonical concept that a
 * release can spell in many ways (H.265 == h265 == HEVC == x265, etc.).
 *
 * Custom formats that are *identified* as belonging to a family (their name
 * or regex mentions any of the family's keywords) automatically match the
 * ENTIRE family's alias set. That's the fix for the tedium of hand-defining
 * `H265`, `h-265`, `265`, `HEVC`, `x265`... as separate formats: add ONE
 * H.265 format and every spelling is caught.
 */
interface FormatFamily {
  label: string;
  /** Regexes tested against a format's own name+regex to flag it as this family. */
  detect: RegExp;
  /** Regex tested against release filenames to see if the family is present. */
  match: RegExp;
}

const FORMAT_FAMILIES: FormatFamily[] = [
  {
    label: 'H.265',
    detect: /265|hevc|h265|hevc1?/i,
    match: /\b(?:x[.\-_ ]?265|h[.\-_ ]?265|hevc|hev1|hvc1|265)\b/i,
  },
  {
    label: 'H.264',
    detect: /264|avc|x264|h264/i,
    match: /\b(?:x[.\-_ ]?264|h[.\-_ ]?264|avc1?|264)\b/i,
  },
  {
    label: 'AV1',
    detect: /av1|av01/i,
    match: /\b(?:av1|av01)\b/i,
  },
  {
    label: 'VP9',
    detect: /vp9/i,
    match: /\bvp9\b/i,
  },
  {
    label: 'HDR',
    detect: /\bhdr/i,
    match: /\b(?:hdr10\+|hdr10plus|hdr10|hdrplus|hdr)\b/i,
  },
  {
    label: 'Dolby Vision',
    detect: /\bdv\b|dolby/i,
    match: /\b(?:dolby[.\-_ ]?vision|dolbyvision|dv)\b/i,
  },
  {
    label: '10-bit',
    detect: /10[.\-_ ]?bit|hi10p/i,
    match: /\b(?:10[.\-_ ]?bit|hi10p)\b/i,
  },
];

/** Technical tags that DON'T map to a family - scanned verbatim. */
const COMMON_TAGS: { name: string; patterns: string[] }[] = [
  { name: 'HLG', patterns: ['hlg'] },
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
  const tags = COMMON_TAGS
    .filter(t => t.patterns.some(p => lower.includes(p)))
    .map(t => t.name);
  for (const fam of FORMAT_FAMILIES) {
    if (fam.match.test(filename)) tags.push(fam.label);
  }
  return [...new Set(tags)];
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
      const userMatches = regex.test(filename);

      // Auto-expand: if this format is a member of a known family (H.265,
      // H.264, HDR, ...) it also matches any of the family's aliases, so one
      // format catches every way the release spells the same thing.
      const family = FORMAT_FAMILIES.find(fam => fam.detect.test(`${f.name} ${f.regex}`));
      const familyMatches = family ? family.match.test(filename) : false;

      const matches = userMatches || familyMatches;

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
