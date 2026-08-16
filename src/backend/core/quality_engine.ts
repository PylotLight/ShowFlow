import { db } from '../db';
import type { ReasonCode } from './pipeline/reason_codes';
import type { MediaProbeInfo } from './media_probe';

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

/** Technical tags that DON'T map to a family - scanned verbatim.
 *
 *  Matching is by word-boundary regex rather than plain substring so that
 *  real-world release names parse correctly (e.g. "DV" doesn't trip on
 *  "DVD", "HDR" doesn't match mid-word hashes, and tags inside brackets/
 *  groups like "[WEB.1080p.AV1]" are still found). */
const COMMON_TAGS: { name: string; patterns: RegExp[] }[] = [
  // ---- HDR / vision ------------------------------------------------------
  { name: 'HLG', patterns: [/\bhlg\b/i] },
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
  const tags: string[] = [];
  for (const tag of COMMON_TAGS) {
    if (tag.patterns.some(p => p.test(filename))) tags.push(tag.name);
  }
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

  /**
   * Media-aware upgrade decision for the blackhole import path.
   *
   * Stored library files are renamed to clean names (no resolution/codec in
   * the filename, e.g. "Reacher - S04E01 - City of Brotherly Love.mkv"), so a
   * filename-only comparison naively treats ANY incoming tagged release as an
   * upgrade over a stored 2160p file. When `existingProbe` is provided we
   * score the EXISTING file from its probed media (resolution, bitrate,
   * codec, HDR) instead of its name, so a stored 2160p is never "upgraded"
   * by an arriving 1080p.
   */
  shouldUpgradeWithMedia(
    existingProbe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'> | null,
    existingFilename: string,
    newFilename: string,
    profileId: string,
  ): boolean {
    const existing = existingProbe
      ? this.getReleaseScoreFromMedia(existingProbe, profileId)
      : this.getReleaseScore(existingFilename, profileId);
    const newcomer = this.getReleaseScore(newFilename, profileId);

    if (newcomer.rejected) return false;

    // Media probing is lossy (no source-type knowledge like WEB vs Remux in
    // the file's own streams) but resolution + bitrate are the dominant
    // terms; require a strict tie-break win so we never replace an
    // equivalent-resolution file just because its bitrate read slightly
    // higher or lower.
    return newcomer.totalScore > existing.totalScore;
  }

  /**
   * Score a file from its probed media streams rather than its (possibly
   * cleaned/renamed) filename. Builds a synthetic "release name" carrying the
   * resolution/codec/HDR/audio tags that detectQuality + the format scorer
   * understand, then reuses the exact same scoring pipeline.
   */
  getReleaseScoreFromMedia(
    probe: Pick<MediaProbeInfo, 'video' | 'audio' | 'overallBitrate' | 'fileSize'>,
    profileId: string,
  ): ReleaseScore {
    const tags: string[] = [];

    // Resolution: bucket by display height (+ width as a tie-breaker for the
    // unusual "1080p but only 1920x960" cropped encodes).
    const width = probe.video?.width ?? null;
    const height = probe.video?.height ?? null;
    const px = width != null && height != null ? width * height : null;
    let resolutionTag: string | null = null;
    if (px != null && px >= 7680 * 4320 * 0.9) resolutionTag = '8K';
    else if (px != null && px >= 3840 * 2160 * 0.8 || (height ?? 0) >= 2000) resolutionTag = '2160p';
    else if (px != null && px >= 1920 * 1080 * 0.8 || (height ?? 0) >= 1000) resolutionTag = '1080p';
    else if ((height ?? 0) >= 700) resolutionTag = '720p';
    else if ((height ?? 0) > 0) resolutionTag = '480p';
    if (resolutionTag) tags.push(resolutionTag);

    // Codec families reusing the same alias sets the format matcher knows.
    const codec = probe.video?.codec ?? '';
    const lowerCodec = codec.toLowerCase();
    if (/265|hevc|h265/.test(lowerCodec)) tags.push('H.265');
    if (/264|avc|h264/.test(lowerCodec)) tags.push('H.264');
    if (/av1|av01/.test(lowerCodec)) tags.push('AV1');
    if (/vp9/.test(lowerCodec)) tags.push('VP9');
    if (probe.video?.hdr) tags.push('HDR');

    // Audio codecs as their COMMON_TAGS names so bonus formats match.
    const audio = probe.audio?.[0]?.codec?.toLowerCase() ?? '';
    if (/truehd/.test(audio)) tags.push('TrueHD');
    if (/dts|ac-?3/.test(audio)) tags.push('DTS');
    if (/eac3|ec-?3|ac-?3/.test(audio)) tags.push('AC3');
    if (/aac/.test(audio)) tags.push('AAC');
    if (/flac/.test(audio)) tags.push('FLAC');
    if (/mlp|atmos/.test(audio)) tags.push('Atmos');

    // Bitrate floors: a 1.8Mbps 1080p encode is not the same "1080p" as an
    // 8Mbps one. Tag low-bitrate files with a hint that depresses their score
    // relative to heavy files. 4 Mbps is the classic "small WEBRip" ceiling.
    const mbps = (probe.overallBitrate ?? 0) / 1_000_000;
    if (mbps < 4) tags.push('bitrate-low');
    // HDR + heavily encoded content signals a remux/BD-grade release.
    if (probe.video?.hdr && mbps >= 20) tags.push('Remux');

    const syntheticName = `Synthetic Release ${tags.join(' ')}`.trim();
    const score = this.getReleaseScore(syntheticName, profileId);
    return score;
  }
}

export const qualityEngine = new QualityEngine();
