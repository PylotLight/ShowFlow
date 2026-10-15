import { db } from '../db';
import type { ReasonCode } from './pipeline/reason_codes';
import type { MediaProbeInfo } from './media_probe';
import { isSampleFile } from './sample_filter';
import { matchTier, topTierAtResolution, parseResolution, parseSource, SOURCE_LABELS, type ReleaseSource, type TierMatch } from './release_quality';

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
  /** Parsed vertical resolution (1080, 2160, ...) or null. */
  resolution?: number | null;
  /** Parsed source (remux, bluray, webdl, ...) or null when the name doesn't say. */
  source?: ReleaseSource | null;
}

/** One profile format's outcome for a release (test box breakdown). */
export interface FormatHit {
  id: string;
  name: string;
  type: 'bonus' | 'required' | 'forbidden';
  score: number;
  matched: boolean;
  /** Concept key used for de-duplication (family label or normalised regex). */
  group: string;
  /** True when this bonus hit was dropped because another format in the same group already counted. */
  deduped: boolean;
  /** Name of the format whose score counted for this group, when deduped. */
  countedAs?: string;
}

export interface FormatScoreResult {
  score: number;
  isForbidden: boolean;
  forbiddenName?: string;
  missingRequired: string[];
  /** Bonus formats that counted toward the score (after de-dup). */
  matchedFormats: string[];
  /** Every attached format, matched or not, with its de-dup outcome. */
  hits: FormatHit[];
}

/**
 * Concept key for a custom format, used to stop aliases stacking.
 *
 * Rule: a format that belongs to a known family (H.265, HDR, DV, 10-bit, ...)
 * is keyed by the family label, so x265 / HEVC / H265 / 265 / H.265 are one
 * concept. Anything else is keyed by its lowercased regex, so two formats with
 * the identical pattern are one concept too. Each concept counts ONCE per
 * release: the highest score among its matching bonus formats wins and the
 * rest are reported as deduped. Required/forbidden are checked per format,
 * before de-dup, so their semantics are unchanged.
 */
export function formatGroupKey(f: { name: string; regex: string }): string {
  const family = FORMAT_FAMILIES.find(fam => fam.detect.test(`${f.name} ${f.regex}`));
  return family ? `family:${family.label}` : `regex:${f.regex.trim().toLowerCase()}`;
}

export class QualityEngine {
  /**
   * Detects the quality of a release based on its filename.
   * Returns the rank and the quality ID if found.
   */
  detectQuality(filename: string): { rank: number; qualityId?: string; matchedQualities: string[]; resolution: number | null; source: ReleaseSource | null; via: TierMatch['via'] } {
    const m = matchTier(filename, db.listQualities() as any[]);
    return {
      rank: m.tier?.rank ?? 0,
      qualityId: m.tier?.id,
      matchedQualities: m.tier ? [m.tier.name] : [],
      resolution: m.resolution,
      source: m.source,
      via: m.via,
    };
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
    if (allowedQualities.some((q: any) => q.id === qualityId)) return { allowed: true, hasRestriction: true };
    // A bare resolution tier in the list ("1080p") means "any source at that
    // resolution". Before source tiers matched, every 1080p release landed on
    // the bare tier, so this keeps bare-only allow-lists accepting exactly
    // what they did.
    const tiers = db.listQualities() as any[];
    const res = parseResolution(tiers.find(t => t.id === qualityId)?.name);
    const bareAllowed = res != null && allowedQualities.some((q: any) => parseResolution(q.name) === res && parseSource(q.name) == null);
    return { allowed: bareAllowed, hasRestriction: true };
  }

  /**
   * Sum of scores for the profile's custom formats that match the filename.
   * Aliases of one concept count once - see formatGroupKey for the rule.
   */
  calculateFormatScore(filename: string, profileId: string): FormatScoreResult {
    const formats = db.getProfileFormats(profileId);
    const missingRequired: string[] = [];
    const hits: FormatHit[] = [];
    let forbiddenName: string | undefined;

    for (const f of formats) {
      let userMatches = false;
      try { userMatches = new RegExp(f.regex, 'i').test(filename); } catch { userMatches = false; }

      // Auto-expand: if this format is a member of a known family (H.265,
      // H.264, HDR, ...) it also matches any of the family's aliases, so one
      // format catches every way the release spells the same thing.
      const family = FORMAT_FAMILIES.find(fam => fam.detect.test(`${f.name} ${f.regex}`));
      const familyMatches = family ? family.match.test(filename) : false;
      const matched = userMatches || familyMatches;
      const type = (f.profile_format_type ?? 'bonus') as FormatHit['type'];

      if (type === 'forbidden' && matched && !forbiddenName) forbiddenName = f.name;
      if (type === 'required' && !matched) missingRequired.push(f.name);
      hits.push({ id: f.id, name: f.name, type, score: f.score ?? 0, matched, group: formatGroupKey(f), deduped: false });
    }

    if (forbiddenName) {
      return { score: 0, isForbidden: true, forbiddenName, missingRequired: [], matchedFormats: [], hits };
    }

    // De-dup: per concept group keep the highest-scoring matched bonus format.
    const winner = new Map<string, FormatHit>();
    for (const h of hits) {
      if (h.type !== 'bonus' || !h.matched) continue;
      const cur = winner.get(h.group);
      if (!cur || h.score > cur.score) winner.set(h.group, h);
    }
    let totalScore = 0;
    const matchedFormats: string[] = [];
    for (const h of hits) {
      if (h.type !== 'bonus' || !h.matched) continue;
      const w = winner.get(h.group)!;
      if (w === h) {
        totalScore += h.score;
        matchedFormats.push(h.name);
      } else {
        h.deduped = true;
        h.countedAs = w.name;
      }
    }

    return { score: totalScore, isForbidden: false, missingRequired, matchedFormats, hits };
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
    const { rank, qualityId, matchedQualities, resolution, source } = this.detectQuality(filename);
    const qualityName = this.resolveQualityName(qualityId);
    const formatResult = this.calculateFormatScore(filename, profileId);
    const matchedTags = [...new Set([...matchedQualities, ...formatResult.matchedFormats, ...scanCommonTags(filename)])];
    const parsed = { resolution, source };

    if (formatResult.isForbidden) {
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Forbidden format matched: ${formatResult.forbiddenName}`, rejectCode: 'FORBIDDEN_FORMAT_MATCHED', matchedTags, ...parsed };
    }

    if (formatResult.missingRequired.length > 0) {
      return { rank, formatScore: -1, totalScore: -1, qualityId, qualityName, rejected: true, rejectReason: `Missing required format(s): ${formatResult.missingRequired.join(', ')}`, rejectCode: 'MISSING_REQUIRED_FORMAT', matchedTags, ...parsed };
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
        ...parsed,
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
      ...parsed,
    };
  }

  /**
   * Compares two files to determine if the new one is an upgrade.
   */
  shouldUpgrade(existingFilename: string, newFilename: string, profileId: string): boolean {
    const existing = this.getReleaseScore(existingFilename, profileId);
    const newcomer = this.getReleaseScore(newFilename, profileId);

    if (newcomer.rejected) return false;
    if (isSampleFile(newFilename)) return false;

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
    /** The stored file's original release title, when known. Lets a real
     *  source upgrade (WEBRip -> WEB-DL at the same resolution) through;
     *  without it the probed file's source is unknown and assumed best. */
    existingReleaseName?: string | null,
  ): boolean {
    const existing = existingProbe
      ? mergeProbeWithRelease(
          this.getReleaseScoreFromMedia(existingProbe, profileId),
          existingReleaseName ? this.getReleaseScore(existingReleaseName, profileId) : null,
        )
      : this.getReleaseScore(existingFilename, profileId);
    const newcomer = this.getReleaseScore(newFilename, profileId);

    if (newcomer.rejected) return false;
    // A sample carries the real release's tags, so against a probed library
    // file it can out-score it on name alone. Never upgrade to one.
    if (isSampleFile(newFilename)) return false;

    // Media probing can't see WEB vs Remux, so getReleaseScoreFromMedia
    // scores an unknown-source file as the best source at its resolution:
    // a same-resolution release only wins on formats, never on source alone
    // (unless the stored release title tells us the real source).
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
    // A probe can't tell WEB-DL from Remux. Rank/qualityName stay the bare
    // resolution tier (that's what the cutoff check and UI show), but the
    // comparison total assumes the best source at that resolution, so an
    // equal-resolution release can't "upgrade" it on source alone. Before
    // source tiers matched, every 1080p release scored as bare 1080p, so this
    // keeps probe comparisons exactly where they were.
    if (!score.rejected && !score.source) {
      const top = topTierAtResolution(score.resolution ?? null, db.listQualities() as any[]);
      if (top && (top.rank ?? 0) > score.rank) score.totalScore = (top.rank ?? 0) * 1000 + score.formatScore;
    }
    return score;
  }
}

/**
 * Combine a probed file's score with its original release title's score.
 * When the title names a source (WEB-DL, BluRay, ...) at the same resolution
 * the probe saw, use the title's tier for the comparison total - the probe
 * still supplies the format score. Otherwise the probe score stands.
 * Shared by the import check and the cutoff upgrade search so both agree.
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
