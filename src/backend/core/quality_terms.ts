/**
 * Streamlined quality model: the built-in term library, fixed weight steps,
 * the fixed source order and the rank formula. Pure, no DB.
 *
 * A profile is: resolution target + minimum (+ allow-unknown), a fixed source
 * order with per-profile skips, and terms (built-in or custom regex) each set
 * to Prefer / Avoid / Must have / Never. Every term counts ONCE per release,
 * so the five spellings of HEVC can't stack the way the old formats did.
 *
 *   rank  = resolutionStep * 10 + sourceStep
 *   total = rank * 1000 + termScore
 *
 * Same shape as the old `tier rank * 1000 + formats`, so cutoff / probe code
 * keeps working.
 */
import { parseResolution, parseSource, type ReleaseSource } from './release_quality';

export type TermMode = 'prefer' | 'strong_prefer' | 'avoid' | 'strong_avoid' | 'must' | 'never';
export const TERM_MODES: TermMode[] = ['prefer', 'strong_prefer', 'avoid', 'strong_avoid', 'must', 'never'];

/** Fixed steps. A strong avoid (-300) outweighs any single prefer plus a codec bonus. */
export const MODE_WEIGHT: Record<TermMode, number> = {
  prefer: 100,
  strong_prefer: 300,
  avoid: -100,
  strong_avoid: -300,
  must: 0,
  never: 0,
};

export type TermGroup = 'codec' | 'hdr' | 'bitdepth' | 'audio' | 'dual' | 'language' | 'release' | 'group';

export const TERM_GROUPS: { id: TermGroup; label: string }[] = [
  { id: 'codec', label: 'Codec' },
  { id: 'hdr', label: 'HDR' },
  { id: 'bitdepth', label: 'Bit depth' },
  { id: 'audio', label: 'Audio' },
  { id: 'dual', label: 'Dual audio / subs' },
  { id: 'language', label: 'Language' },
  { id: 'release', label: 'Release' },
  { id: 'group', label: 'Release groups' },
];

export interface BuiltinTerm {
  id: string;
  group: TermGroup;
  label: string;
  match: RegExp;
}

const L = '(?<![a-z0-9])';
const R = '(?![a-z0-9])';
const w = (src: string) => new RegExp(`${L}(?:${src})${R}`, 'i');
/** A release group: `[Group]` anywhere or `-Group` at the end (before the extension). */
const grp = (name: string) => new RegExp(`(?:\\[${name}\\]|-${name}(?:\\.(?:mkv|mp4|avi|ts|m2ts))?\\s*$)`, 'i');

export const BUILTIN_TERMS: BuiltinTerm[] = [
  { id: 'hevc', group: 'codec', label: 'HEVC / x265', match: w('x[.\\-_ ]?265|h[.\\-_ ]?265|hevc|hvc1|hev1') },
  { id: 'avc', group: 'codec', label: 'AVC / x264', match: w('x[.\\-_ ]?264|h[.\\-_ ]?264|avc1?') },
  { id: 'av1', group: 'codec', label: 'AV1', match: w('av1|av01') },

  { id: 'dv', group: 'hdr', label: 'Dolby Vision', match: w('dv|dovi|dolby[.\\-_ ]?vision|dolbyvision') },
  { id: 'hdr10plus', group: 'hdr', label: 'HDR10+', match: /(?<![a-z0-9])(?:hdr10\+|hdr10[.\-_ ]?plus)/i },
  { id: 'hdr', group: 'hdr', label: 'Any HDR', match: /(?<![a-z0-9])(?:hdr(?:10\+?|10[.\-_ ]?plus)?|hlg|dv|dovi|dolby[.\-_ ]?vision)(?![a-z0-9])/i },

  { id: '10bit', group: 'bitdepth', label: '10-bit', match: w('10[.\\-_ ]?bits?|hi10p?') },

  { id: 'atmos', group: 'audio', label: 'Atmos', match: w('atmos') },
  { id: 'truehd', group: 'audio', label: 'TrueHD', match: w('truehd') },
  { id: 'dtshd', group: 'audio', label: 'DTS-HD / DTS:X', match: w('dts[.\\-_ ]?(?:hd|x)(?:[.\\-_ ]?ma)?|dtsx|dts[.\\-_ ]?hd[.\\-_ ]?ma') },
  { id: 'ddp', group: 'audio', label: 'DD+ / EAC3', match: /(?<![a-z0-9])(?:ddp|dd\+|e[.\-_]?ac[.\-_]?3)/i },
  { id: 'aac', group: 'audio', label: 'AAC', match: /(?<![a-z0-9])aac/i },
  { id: 'flac', group: 'audio', label: 'FLAC', match: w('flac') },

  { id: 'dual_audio', group: 'dual', label: 'Dual audio', match: w('dual[.\\-_ ]?audio|dual') },
  { id: 'multi_subs', group: 'dual', label: 'Multi-subs', match: w('multi[.\\-_ ]?(?:subs?|subtitles?)|multisubs?') },

  { id: 'vostfr', group: 'language', label: 'VOSTFR', match: w('vostfr') },
  { id: 'multi', group: 'language', label: 'MULTi (multi-language)', match: /(?<![a-z0-9])multi(?![a-z0-9])(?![.\-_ ]?(?:subs?|subtitles?))/i },
  { id: 'french', group: 'language', label: 'French', match: w('french|truefrench|vff|vf2') },
  { id: 'german', group: 'language', label: 'German', match: w('german') },
  { id: 'italian', group: 'language', label: 'Italian', match: w('ita|italian') },
  { id: 'spanish', group: 'language', label: 'Spanish', match: w('spanish|castellano|latino') },

  { id: 'repack', group: 'release', label: 'Repack / Proper', match: w('repack\\d?|proper|rerip') },
  { id: 'hardsub', group: 'release', label: 'Hardsubs', match: w('hardsubs?|hc') },

  { id: 'g_subsplease', group: 'group', label: 'SubsPlease', match: grp('subsplease') },
  { id: 'g_erai', group: 'group', label: 'Erai-raws', match: grp('erai-raws') },
  { id: 'g_judas', group: 'group', label: 'Judas', match: grp('judas') },
  { id: 'g_asw', group: 'group', label: 'ASW', match: grp('asw') },
  { id: 'g_ember', group: 'group', label: 'EMBER', match: grp('ember') },
  { id: 'g_ntb', group: 'group', label: 'NTb', match: grp('ntb') },
  { id: 'g_flux', group: 'group', label: 'FLUX', match: grp('flux') },
  { id: 'g_framestor', group: 'group', label: 'FraMeSToR', match: grp('framestor') },
];

const BY_ID = new Map(BUILTIN_TERMS.map(t => [t.id, t]));
export function getBuiltinTerm(id: string): BuiltinTerm | undefined {
  return BY_ID.get(id);
}

/** Custom terms are stored as `custom:<id>` in profile_terms.term_id. */
export const CUSTOM_PREFIX = 'custom:';
export function isCustomTermId(termId: string): boolean {
  return termId.startsWith(CUSTOM_PREFIX);
}

// ---- resolution + source ----------------------------------------------------

export const RESOLUTIONS = [480, 720, 1080, 2160, 4320] as const;

const RES_STEP: Record<number, number> = { 480: 1, 576: 1, 720: 2, 1080: 3, 2160: 4, 4320: 5 };
export function resolutionStep(res: number | null | undefined): number {
  return res == null ? 0 : RES_STEP[res] ?? 0;
}

/** Fixed source order, best first. Unknown source sits between WEB-DL and WEBRip:
 *  most names without one are fansub/web groups, and it keeps a VOSTFR WEBRip
 *  from winning on source alone over a clean untagged release. */
export const SOURCE_ORDER: ReleaseSource[] = ['remux', 'bluray', 'webdl', 'webrip', 'hdtv', 'dvd', 'sdtv'];
const SOURCE_STEP: Record<ReleaseSource, number> = { remux: 7, bluray: 6, webdl: 5, webrip: 3, hdtv: 2, dvd: 1, sdtv: 1 };
export const UNKNOWN_SOURCE_STEP = 4;
/** What a probed file (source unknowable) is assumed to be for comparisons. */
export const BEST_SOURCE_STEP = 7;

export function sourceStep(source: ReleaseSource | null | undefined): number {
  return source ? SOURCE_STEP[source] : UNKNOWN_SOURCE_STEP;
}

/** Resolution of a release, inferring 480 for DVD/SDTV names with no explicit one. */
export function releaseResolution(name: string, source: ReleaseSource | null = parseSource(name)): number | null {
  const res = parseResolution(name);
  if (res != null) return res;
  if (source === 'dvd' || source === 'sdtv') return 480;
  return null;
}

export function qualityRank(res: number | null, source: ReleaseSource | null): number {
  if (res == null && source == null) return 0;
  return resolutionStep(res) * 10 + sourceStep(source);
}

const TIER_PREFIX: Record<ReleaseSource, string> = {
  remux: 'Remux', bluray: 'Bluray', webdl: 'WEBDL', webrip: 'WEBRip', hdtv: 'HDTV', dvd: 'DVD', sdtv: 'SDTV',
};

/** Display name in the old tier style ("WEBDL-1080p", bare "1080p", "DVD"). */
export function qualityLabel(res: number | null, source: ReleaseSource | null): string | undefined {
  if (res == null) return source ? TIER_PREFIX[source] : undefined;
  if (source === 'dvd' || source === 'sdtv') return res <= 576 ? TIER_PREFIX[source] : `${res}p`;
  return source ? `${TIER_PREFIX[source]}-${res}p` : `${res}p`;
}

// ---- term scoring -------------------------------------------------------------

export interface ResolvedTerm {
  termId: string;
  label: string;
  group: TermGroup | 'custom';
  mode: TermMode;
  /** Numeric override (Advanced). null = the mode's fixed step. */
  weight: number | null;
  /** Regex for custom terms, null for built-ins. */
  regex: string | null;
}

export interface TermHit {
  termId: string;
  label: string;
  group: TermGroup | 'custom';
  mode: TermMode;
  weight: number;
  matched: boolean;
  /** True when a custom term's regex doesn't compile (never matches). */
  invalid?: boolean;
}

export interface TermScore {
  score: number;
  hits: TermHit[];
  neverMatched: string | null;
  missingMust: string[];
}

export function effectiveWeight(t: { mode: TermMode; weight: number | null }): number {
  if (t.mode === 'must' || t.mode === 'never') return 0;
  return t.weight ?? MODE_WEIGHT[t.mode];
}

export function termMatches(t: Pick<ResolvedTerm, 'termId' | 'regex'>, name: string): { matched: boolean; invalid?: boolean } {
  if (t.regex != null) {
    try { return { matched: new RegExp(t.regex, 'i').test(name) }; } catch { return { matched: false, invalid: true }; }
  }
  const b = getBuiltinTerm(t.termId);
  return { matched: b ? b.match.test(name) : false };
}

/** Score a release's terms. Each term counts once. */
export function scoreTerms(name: string, terms: ResolvedTerm[]): TermScore {
  const hits: TermHit[] = [];
  let score = 0;
  let neverMatched: string | null = null;
  const missingMust: string[] = [];
  for (const t of terms) {
    const m = termMatches(t, name);
    const weight = effectiveWeight(t);
    hits.push({ termId: t.termId, label: t.label, group: t.group, mode: t.mode, weight, matched: m.matched, ...(m.invalid ? { invalid: true } : {}) });
    if (t.mode === 'never' && m.matched && !neverMatched) neverMatched = t.label;
    if (t.mode === 'must' && !m.matched) missingMust.push(t.label);
    if (m.matched) score += weight;
  }
  return { score, hits, neverMatched, missingMust };
}

/** Built-in term ids a piece of text mentions (used by the legacy-format merge and Sonarr mapping). */
export function builtinTermsIn(text: string): string[] {
  // "Any HDR" overlaps DV / HDR10+: a text naming DV or HDR10+ is that term, not "any HDR".
  const ids = BUILTIN_TERMS.filter(t => t.match.test(text)).map(t => t.id);
  const specific = ids.filter(id => id !== 'hdr');
  if (ids.includes('hdr') && specific.some(id => id === 'dv' || id === 'hdr10plus')) return specific;
  return ids;
}

// ---- presets ------------------------------------------------------------------

export interface PresetTerm { termId: string; mode: TermMode }
export interface ProfilePreset {
  id: string;
  name: string;
  description: string;
  minResolution: number | null;
  targetResolution: number | null;
  allowUnknownResolution: boolean;
  skipSources: ReleaseSource[];
  upgradesEnabled: boolean;
  upgradeUntil: { resolution: number | null; source: ReleaseSource | null } | null;
  terms: PresetTerm[];
}

export const PRESETS: ProfilePreset[] = [
  {
    id: 'web1080',
    name: '1080p web',
    description: '1080p, down to 720p. no HDTV. upgrade until 1080p WEB-DL.',
    minResolution: 720,
    targetResolution: 1080,
    allowUnknownResolution: true,
    skipSources: ['hdtv', 'dvd', 'sdtv'],
    upgradesEnabled: true,
    upgradeUntil: { resolution: 1080, source: 'webdl' },
    terms: [
      { termId: 'repack', mode: 'prefer' },
      { termId: 'hardsub', mode: 'never' },
    ],
  },
  {
    id: '4khdr',
    name: '4K HDR',
    description: '2160p, down to 1080p. prefers DV / HDR10+ / Atmos. upgrade until 2160p WEB-DL.',
    minResolution: 1080,
    targetResolution: 2160,
    allowUnknownResolution: true,
    skipSources: ['hdtv', 'dvd', 'sdtv'],
    upgradesEnabled: true,
    upgradeUntil: { resolution: 2160, source: 'webdl' },
    terms: [
      { termId: 'dv', mode: 'prefer' },
      { termId: 'hdr10plus', mode: 'prefer' },
      { termId: 'hdr', mode: 'prefer' },
      { termId: 'atmos', mode: 'prefer' },
      { termId: 'repack', mode: 'prefer' },
    ],
  },
  {
    id: 'anime',
    name: 'Anime (SubsPlease)',
    description: '1080p. prefers SubsPlease / Erai-raws, dual audio and HEVC. never VOSTFR. upgrades off.',
    minResolution: 720,
    targetResolution: 1080,
    allowUnknownResolution: true,
    skipSources: [],
    upgradesEnabled: false,
    upgradeUntil: null,
    terms: [
      { termId: 'g_subsplease', mode: 'prefer' },
      { termId: 'g_erai', mode: 'prefer' },
      { termId: 'dual_audio', mode: 'prefer' },
      { termId: 'hevc', mode: 'prefer' },
      { termId: 'vostfr', mode: 'never' },
      { termId: 'hardsub', mode: 'avoid' },
    ],
  },
];

export function isReleaseSource(s: unknown): s is ReleaseSource {
  return typeof s === 'string' && (SOURCE_ORDER as string[]).includes(s);
}

export { parseResolution, parseSource };
export type { ReleaseSource };
