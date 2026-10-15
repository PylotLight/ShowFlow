/**
 * Legacy profile -> streamlined model conversion. Pure (no DB) so it can be
 * tested directly and run in-memory for a profile that hasn't been persisted
 * yet. db/quality_model.ts persists the result once at boot.
 *
 * Rules (see docs in the PR):
 *  - each attached custom format is classified by its regex (then its name):
 *      one built-in term     -> merged into that term (5 HEVC spellings -> one "HEVC")
 *      a resolution (2160p)  -> folded into target/min (dropped as a term)
 *      a source (Remux, WEB) -> fixed source order covers bonuses; forbidden -> skip source
 *      anything else         -> kept as a custom regex term with its exact weight
 *  - weights snap to fixed steps for built-ins: >=100 strong prefer, >0 prefer,
 *    <0 avoid, but an avoid at least as heavy as the profile's biggest bonus
 *    (or <= -100) becomes strong avoid so it still beats any one prefer.
 *    0 bonus = neutral, dropped. required -> must, forbidden -> never.
 *  - allowed qualities -> min/target (+ skip sources when the list only had
 *    source tiers); empty list -> unrestricted.
 *  - cutoff -> upgrade until that quality; no cutoff -> upgrades OFF (which now
 *    also stops imports replacing files).
 */
import {
  builtinTermsIn, getBuiltinTerm, cleanGroupName, LEGACY_GROUP_TERMS, groupTermId, groupNameOf, isGroupTermId, CUSTOM_PREFIX, RESOLUTIONS, SOURCE_ORDER,
  type TermMode, type ReleaseSource,
} from './quality_terms';
import { parseResolution, parseSource, SOURCE_LABELS } from './release_quality';
import { parseReleaseGroup } from './release_meta';

export interface LegacyFormat { id: string; name: string; regex: string; score: number | null; type: string | null }
export interface LegacyQuality { id: string; name: string; rank?: number | null }

export interface ConvertedTerm {
  termId: string;
  mode: TermMode;
  weight: number | null;
  /** For custom terms: the custom_terms row to create (id = legacy format id). */
  custom?: { id: string; name: string; regex: string };
}

export interface ConvertedProfile {
  minResolution: number | null;
  targetResolution: number | null;
  allowUnknownResolution: boolean;
  skipSources: ReleaseSource[];
  upgradesEnabled: boolean;
  upgradeUntilResolution: number | null;
  upgradeUntilSource: ReleaseSource | null;
  terms: ConvertedTerm[];
  notes: string[];
}

/** Turn regex source into something the term/resolution matchers can read. */
export function regexToText(regex: string): string {
  return regex
    .replace(/\\[bBdDsSwW]/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[?*^$|(){}]/g, ' ');
}

/** quality_engine_legacy FORMAT_FAMILIES detect regexes, in the same order. */
const LEGACY_FAMILIES: { detect: RegExp; termId: string | null }[] = [
  { detect: /265|hevc|h265|hevc1?/i, termId: 'hevc' },
  { detect: /264|avc|x264|h264/i, termId: 'avc' },
  { detect: /av1|av01/i, termId: 'av1' },
  { detect: /vp9/i, termId: null },
  { detect: /\bhdr/i, termId: 'hdr' },
  { detect: /\bdv\b|dolby/i, termId: 'dv' },
  { detect: /10[.\-_ ]?bit|hi10p/i, termId: '10bit' },
];

type Classified =
  | { kind: 'term'; termId: string }
  | { kind: 'resolution'; res: number }
  | { kind: 'source'; source: ReleaseSource }
  | { kind: 'custom' };

/** A format whose regex is just one release group: `\[Group\]`, `-Group$`, `-Group\b`. */
export function groupFromRegex(regex: string): string | null {
  const m = /^\^?(?:\\\[([A-Za-z0-9][A-Za-z0-9 _&@!+-]*)\\\]|-([A-Za-z0-9][A-Za-z0-9_&@!+]*)(?:\$|\\b)?)$/.exec(regex.trim());
  const g = m ? cleanGroupName(m[1] ?? m[2]) : null;
  // "-x265" / "\[1080p\]" are codec/quality formats, not groups
  return g && parseReleaseGroup(`[${g}] x`) === g ? g : null;
}

export function classifyFormat(f: Pick<LegacyFormat, 'name' | 'regex'>): Classified {
  // Only the groups that used to be built-in chips merge into a group term
  // (as they did before); any other group regex stays a custom term with its
  // exact weight, same as before.
  const group = groupFromRegex(f.regex);
  const known = group ? Object.values(LEGACY_GROUP_TERMS).find(n => n.toLowerCase() === group.toLowerCase()) : undefined;
  if (known) return { kind: 'term', termId: groupTermId(known) };
  const fromRegex = builtinTermsIn(regexToText(f.regex));
  if (fromRegex.length === 1) return { kind: 'term', termId: fromRegex[0]! };
  if (fromRegex.length === 0) {
    // The old engine expanded codec/HDR families off the format's NAME too,
    // so a format named "HEVC" matched every spelling whatever its regex.
    const fromName = builtinTermsIn(f.name);
    if (fromName.length === 1) return { kind: 'term', termId: fromName[0]! };
  }
  if (fromRegex.length > 1) return { kind: 'custom' };
  const text = regexToText(f.regex);
  // Last resort: the old engine's family detection (first match wins). A
  // format it filed under a family (e.g. a bare "265") matched every spelling,
  // so it's that term now - otherwise it would stack on top of HEVC again.
  if (parseResolution(text) == null && parseSource(text) == null) {
    const fam = LEGACY_FAMILIES.find(x => x.detect.test(`${f.name} ${f.regex}`));
    if (fam?.termId) return { kind: 'term', termId: fam.termId };
  }
  const res = parseResolution(text) ?? (parseResolution(f.regex) == null ? parseResolution(f.name) : null);
  const src = parseSource(text) ?? parseSource(f.name);
  if (res != null && src == null) return { kind: 'resolution', res };
  if (src != null && res == null) return { kind: 'source', source: src };
  return { kind: 'custom' };
}

function bonusMode(score: number, maxPositive: number): TermMode | null {
  if (score >= 100) return 'strong_prefer';
  if (score > 0) return 'prefer';
  if (score < 0) return (score <= -100 || (maxPositive > 0 && -score >= maxPositive)) ? 'strong_avoid' : 'avoid';
  return null;
}

const MODE_LABEL: Record<TermMode, string> = {
  prefer: 'prefer', strong_prefer: 'strong prefer', avoid: 'avoid', strong_avoid: 'strong avoid', must: 'must have', never: 'never',
};

function resOf(q: LegacyQuality): number | null {
  const r = parseResolution(q.name);
  if (r != null) return r;
  const s = parseSource(q.name);
  return s === 'dvd' || s === 'sdtv' || s === 'hdtv' ? 480 : null;
}

export function convertLegacyProfile(input: {
  formats: LegacyFormat[];
  allowed: LegacyQuality[];
  cutoff: { name: string } | null;
}): ConvertedProfile {
  const notes: string[] = [];
  const out: ConvertedProfile = {
    minResolution: null,
    targetResolution: null,
    allowUnknownResolution: true,
    skipSources: [],
    upgradesEnabled: false,
    upgradeUntilResolution: null,
    upgradeUntilSource: null,
    terms: [],
    notes,
  };

  // ---- allowed qualities -> min / target / skip sources
  if (input.allowed.length > 0) {
    const resList = input.allowed.map(resOf).filter((r): r is number => r != null);
    if (resList.length) {
      out.minResolution = Math.min(...resList);
      out.targetResolution = Math.max(...resList);
      const between = RESOLUTIONS.filter(r => r > out.minResolution! && r < out.targetResolution!);
      const have = new Set(resList.map(r => (r === 576 ? 480 : r)));
      const gaps = between.filter(r => !have.has(r));
      if (gaps.length) notes.push(`allowed list skipped ${gaps.map(r => `${r}p`).join(', ')}; now everything from ${out.minResolution}p to ${out.targetResolution}p is allowed`);
    }
    out.allowUnknownResolution = false;
    const hasBare = input.allowed.some(q => parseSource(q.name) == null);
    if (!hasBare) {
      const allowedSources = new Set(input.allowed.map(q => parseSource(q.name)).filter(Boolean) as ReleaseSource[]);
      out.skipSources = SOURCE_ORDER.filter(s => !allowedSources.has(s));
    }
  }

  // ---- cutoff -> upgrade until
  if (input.cutoff) {
    out.upgradesEnabled = true;
    const src = parseSource(input.cutoff.name);
    out.upgradeUntilResolution = parseResolution(input.cutoff.name) ?? (src ? 480 : null);
    out.upgradeUntilSource = src;
  } else {
    notes.push('no cutoff, so upgrades are off. imports no longer replace existing files either');
  }

  // ---- formats
  // Biggest bonus among formats that stay terms (resolution/source formats
  // are folded away, so they don't count): an avoid at least this heavy
  // becomes strong avoid.
  const maxPositive = Math.max(0, ...input.formats
    .filter(f => (f.type ?? 'bonus') === 'bonus' && (() => { const k = classifyFormat(f).kind; return k === 'term' || k === 'custom'; })())
    .map(f => f.score ?? 0));
  const byTerm = new Map<string, LegacyFormat[]>();
  for (const f of input.formats) {
    const type = f.type ?? 'bonus';
    const score = f.score ?? 0;
    const c = classifyFormat(f);
    if (c.kind === 'term') {
      const list = byTerm.get(c.termId) ?? [];
      list.push(f);
      byTerm.set(c.termId, list);
      continue;
    }
    if (c.kind === 'resolution') {
      if (type === 'required') {
        out.minResolution = Math.max(out.minResolution ?? 0, c.res);
        if (out.targetResolution != null && out.targetResolution < c.res) out.targetResolution = c.res;
        notes.push(`required format "${f.name}" became minimum resolution ${out.minResolution}p`);
        continue;
      }
      if (type === 'forbidden') {
        const below = [...RESOLUTIONS].reverse().find(r => r < c.res) ?? null;
        out.targetResolution = out.targetResolution == null ? below : Math.min(out.targetResolution, below ?? out.targetResolution);
        notes.push(`forbidden format "${f.name}" became target resolution ${out.targetResolution}p`);
        continue;
      }
      if (score > 0) {
        if (out.targetResolution == null) {
          out.targetResolution = c.res;
          notes.push(`format "${f.name}" became the resolution target (${c.res}p)`);
        } else {
          notes.push(`format "${f.name}" dropped: resolution is ranked already`);
        }
        continue;
      }
      if (score === 0) { notes.push(`format "${f.name}" dropped: it scored 0`); continue; }
      // negative resolution bonus: keep it as a custom term so the decision holds
    }
    if (c.kind === 'source') {
      if (type === 'forbidden') {
        if (!out.skipSources.includes(c.source)) out.skipSources.push(c.source);
        notes.push(`forbidden format "${f.name}" became skip source ${SOURCE_LABELS[c.source]}`);
        continue;
      }
      if (type === 'bonus' && score >= 0) {
        notes.push(`format "${f.name}" dropped: the fixed source order covers it`);
        continue;
      }
    }
    // custom term, keeps its exact weight
    const mode: TermMode | null = type === 'required' ? 'must' : type === 'forbidden' ? 'never' : (score < 0 ? 'avoid' : 'prefer');
    out.terms.push({
      termId: `${CUSTOM_PREFIX}${f.id}`,
      mode: mode!,
      weight: mode === 'must' || mode === 'never' ? null : score,
      custom: { id: f.id, name: f.name, regex: f.regex },
    });
  }

  for (const [termId, fs] of byTerm) {
    const label = isGroupTermId(termId) ? groupNameOf(termId) : getBuiltinTerm(termId)!.label;
    let mode: TermMode | null;
    if (fs.some(f => f.type === 'forbidden')) mode = 'never';
    else if (fs.some(f => f.type === 'required')) mode = 'must';
    else {
      const scores = fs.map(f => f.score ?? 0);
      const pick = scores.reduce((a, b) => (Math.abs(b) > Math.abs(a) || (Math.abs(b) === Math.abs(a) && b > a) ? b : a), 0);
      mode = bonusMode(pick, maxPositive);
    }
    if (!mode) {
      notes.push(`${fs.map(f => `"${f.name}"`).join(', ')} dropped: scored 0`);
      continue;
    }
    if (fs.length > 1) notes.push(`merged ${fs.length} formats (${fs.map(f => f.name).join(', ')}) into ${label}: ${MODE_LABEL[mode]}`);
    out.terms.push({ termId, mode, weight: null });
  }

  return out;
}
