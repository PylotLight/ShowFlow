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

// Tags that look like a trailing release group but are actually codec/source/
// quality descriptors, so we never mistake them for the scene group.
const NOT_A_GROUP = /^(?:x\d{2,4}|h\.?26[45]|hevc|avc|hdr(?:10)?(?:plus|p|\+)?|sdr|ddp?[0-9.]*|dd[0-9.]*|aac\d?|ac3|eac3|dts(?:[\s._-]?hd)?(?:[\s._-]?ma)?|truehd|flac|atmos|dts[\s._-]?x|web[\s._-]?dl|webrip|web|dl|bluray|bdrip|bd|remux|hdtv|dsr|dvb|uhd|multi(?:[\s._-]?(?:subs?|audio))?|dual|proper|repack|internal|extended|imax|3d|s\d{1,3}(?:[\s._-]?e\d{1,3})?|ep\d{1,3}|pal|ntsc|60fps|24fps|fps|[57][.]1|\d{3,4}p)$/i;

/**
 * Trailing scene release group from a release name or filename (the `-GROUP`
 * after the last separator). Strips a container extension first. Returns ''
 * when the tail is actually a codec/source/quality tag rather than a group.
 */
export function releaseGroup(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const idx = Math.max(base.lastIndexOf('-'), base.lastIndexOf('_'));
  if (idx < 0) return '';
  const g = base.slice(idx + 1).replace(/[._]+/g, ' ').trim();
  if (g.length < 2 || g.length > 30) return '';
  if (NOT_A_GROUP.test(g)) return '';
  return g.toLowerCase();
}

function normTitle(t: string): string[] {
  const n = t.normalize('NFKC').replace(/[._-]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return n ? n.split(' ') : [];
}

/**
 * Does a grabbed release title refer to the same release as a landed file
 * (its original filename)? Used to decide whether a grab's provenance may be
 * attached to a file the scanner/import actually found on disk, instead of
 * blindly crediting whatever the most recent grab for the show happened to be.
 *
 * Primary signal is the trailing scene group — it's the strongest identity
 * token and exactly what distinguishes a FraMeSToR REMUX from a DirtyHippie
 * RIFE re-encode of the same movie. When both sides carry a group, they must
 * agree. Otherwise fall back to token containment: a grabbed title is usually
 * the "core" of the file name (the file may carry extra codec/audio tokens), so
 * we measure how much of the smaller token set the larger one contains.
 */
export function releaseTitlesMatch(grabTitle: string, landedFileName: string): boolean {
  if (!grabTitle || !landedFileName) return false;
  const gGrab = releaseGroup(grabTitle);
  const gFile = releaseGroup(landedFileName);
  if (gGrab && gFile) return gGrab === gFile;
  const a = new Set(normTitle(grabTitle));
  const b = new Set(normTitle(landedFileName));
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size) >= 0.8;
}
