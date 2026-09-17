/**
 * Filename-derived release metadata.
 *
 * A media probe (media_probe.ts) reads what is *actually in the file* —
 * resolution, codec, real frame rate, HDR yes/no, audio codec + channels,
 * bitrate. It cannot see the marketing/HDR-format nuances that a release name
 * carries: whether HDR is Dolby Vision vs HDR10+ vs plain HDR10, whether a
 * TrueHD track is object-based Atmos, bit depth, the source grade (REMUX vs
 * WEB-DL), the language set (MULTI/DUAL), or editorial passes like AI upscaling
 * / RIFE frame interpolation. This module extracts exactly those, from the
 * original release filename we keep on every episode_files row.
 *
 * It intentionally does NOT duplicate what the probe already answers reliably
 * (resolution, codec, fps) — the caller merges both, letting the file win where
 * they overlap.
 */

export type HdrFormat = 'Dolby Vision' | 'HDR10+' | 'HDR10' | 'HLG';

export interface ReleaseMeta {
  /** Most specific HDR presentation the name advertises, or null for SDR/none.
   *  Priority: Dolby Vision > HDR10+ > HDR10; HLG is tracked only in `tags`. */
  hdrFormat: HdrFormat | null;
  /** Display-facing tags the probe can't derive (Atmos, 10-bit, REMUX, …). */
  tags: string[];
}

// HDR-format tokens are matched against the whole (dot/underscore-normalised)
// name, so "DV.HDR10Plus" and "HDR10+" both resolve. Order below is priority.
const HDR_FORMAT_PATTERNS: { format: HdrFormat; re: RegExp }[] = [
  { format: 'Dolby Vision', re: /\b(?:dolby[\s._-]?vision|dolbyvision|dovi|dv)\b/i },
  { format: 'HDR10+', re: /\b(?:hdr[\s._-]?10[\s._-]?(?:\+|plus|p)|hdr10plus|hdr[\s._-]?plus)\b/i },
  { format: 'HDR10', re: /\bhdr[\s._-]?10\b(?![\s._-]?(?:\+|plus|p))\b/i },
];

const HLG_RE = /\bh(?:lg|dr)?\b|\bhybrid[\s._-]?log[\s._-]?gamma\b/i;

// Curated, human-facing tags. Each is only worth surfacing when the probe
// can't already tell us (that's why plain codecs like x265/HEVC aren't here —
// those come from the file). Grouped for readability; the label is what shows.
const TAG_PATTERNS: { label: string; re: RegExp }[] = [
  // Object / immersive audio
  { label: 'Atmos', re: /\batmos\b/i },
  { label: 'DTS-X', re: /\bdts[\s._-]?x\b/i },
  { label: 'DTS-HD MA', re: /\bdts[\s._-]?hd[\s._-]?ma\b/i },
  // Bit depth
  { label: '10-bit', re: /\b(?:10[\s._-]?bit|hi10p)\b/i },
  // Source grade
  { label: 'Remux', re: /\bremux\b/i },
  { label: 'BluRay', re: /\b(?:blu[\s._-]?rays?|bdrip|bd\b)\b/i },
  { label: 'WEB-DL', re: /\bweb[\s._-]?dl\b/i },
  { label: 'WEBRip', re: /\bweb[\s._-]?rips?\b/i },
  { label: 'HDTV', re: /\b(?:hdtv|dsr|dvb)\b/i },
  // Versions / edits
  { label: 'Repack', re: /\brepack\b/i },
  { label: 'Proper', re: /\bproper\b/i },
  { label: 'Extended', re: /\bextended\b/i },
  { label: 'IMAX', re: /\bimax\b/i },
  { label: '3D', re: /\b3d\b/i },
  // Languages / audio set (also confirmed against probe languages when known).
  // Bare MULTI/DUAL in a release name conventionally means multi/dual audio or
  // language, so match them generically as well as the explicit spellings.
  { label: 'Dual-Audio', re: /\bdual\b/i },
  { label: 'Multi-Audio', re: /\bmulti\b/i },
  { label: 'Multi-Subs', re: /\bmulti[\s._-]?(?:subs?|subtitle)\b/i },
  // Editorial passes that leave no reliable container fingerprint
  { label: 'AI-Enhanced', re: /\bai[\s._-]?(?:enhanced|upscaled|remaster)/i },
  { label: 'Upscaled', re: /\b(?:upscaled|upscaling)/i },
  { label: 'RIFE', re: /\brife\b/i },
];

/**
 * Parse a release filename (the pre-rename `original_name`) into HDR format +
 * display tags. Returns nulls/empties for anything unrecognisable; never
 * throws. A blank name yields { hdrFormat: null, tags: [] }.
 */
export function extractReleaseMeta(name: string | null | undefined): ReleaseMeta {
  if (!name) return { hdrFormat: null, tags: [] };
  // Normalise separators so "HDR10_Plus" and "HDR10.Plus" match the same way.
  const text = ` ${name.replace(/[._\-]+/g, ' ')} `;

  let hdrFormat: HdrFormat | null = null;
  for (const { format, re } of HDR_FORMAT_PATTERNS) {
    if (re.test(text)) {
      hdrFormat = format;
      break;
    }
  }

  const tags: string[] = [];
  if (HLG_RE.test(text)) tags.push('HLG');
  for (const { label, re } of TAG_PATTERNS) {
    if (re.test(text)) tags.push(label);
  }
  return { hdrFormat, tags: [...new Set(tags)] };
}
