/**
 * Resolution + source parsing for release names, and mapping that pair onto
 * the user's quality_definitions tiers.
 *
 * Before this, detectQuality did a lowercase substring match of every tier
 * name ("webdl-1080p", "remux-1080p", ...) against the title. Real titles say
 * `1080p.WEB-DL` / `BluRay.REMUX`, so every source tier was dead and
 * everything landed on the bare `1080p` / `2160p` rows. Now resolution and
 * source are parsed independently and combined into the existing tier names,
 * so Remux > BluRay > WEB-DL > WEBRip > HDTV actually rank per the tier order.
 *
 * Pure functions, no DB - the engine passes the tier list in.
 */

export type ReleaseSource = 'remux' | 'bluray' | 'webdl' | 'webrip' | 'hdtv' | 'dvd' | 'sdtv';

/** Display labels for parsed sources. */
export const SOURCE_LABELS: Record<ReleaseSource, string> = {
  remux: 'Remux',
  bluray: 'BluRay',
  webdl: 'WEB-DL',
  webrip: 'WEBRip',
  hdtv: 'HDTV',
  dvd: 'DVD',
  sdtv: 'SDTV',
};

/** Normalise separators so "BluRay.REMUX", "Blu_Ray" and "WEB-DL" tokenise the same. */
function normalise(name: string): string {
  return ` ${name.replace(/[._[\](){}+,]+/g, ' ')} `;
}

/**
 * Vertical resolution a release advertises, or null.
 * 480/576/720/1080/2160/4320 with a p/i suffix, WxH forms (1920x1080),
 * and 4K/UHD -> 2160, 8K -> 4320. When a name carries several, the highest wins.
 */
export function parseResolution(name: string | null | undefined): number | null {
  if (!name) return null;
  const text = normalise(name);
  const found: number[] = [];
  for (const m of text.matchAll(/(?<![a-z0-9])(480|576|720|1080|2160|4320)[pi](?![a-z0-9])/gi)) found.push(Number(m[1]));
  for (const m of text.matchAll(/(?<![a-z0-9])\d{3,4}x(480|576|720|1080|2160|4320)(?![a-z0-9])/gi)) found.push(Number(m[1]));
  if (/(?<![a-z0-9])8k(?![a-z0-9])/i.test(text)) found.push(4320);
  if (/(?<![a-z0-9])(?:4k|uhd)(?![a-z0-9])/i.test(text)) found.push(2160);
  return found.length ? Math.max(...found) : null;
}

// Ordered best-first: a name that says both "BluRay" and "REMUX" is a remux,
// "BDRip ... WEB" is still BluRay, etc.
const SOURCE_PATTERNS: { source: ReleaseSource; re: RegExp }[] = [
  { source: 'remux', re: /(?<![a-z0-9])(?:bd|uhd|blu[\s-]?ray)?[\s-]?remux(?![a-z0-9])/i },
  { source: 'bluray', re: /(?<![a-z0-9])(?:blu[\s-]?rays?|bdrip|brrip|bdmv|bd|bd25|bd50|uhd[\s-]?bluray)(?![a-z0-9])/i },
  { source: 'webdl', re: /(?<![a-z0-9])(?:web[\s-]?dl|webdl)(?![a-z0-9])/i },
  { source: 'webrip', re: /(?<![a-z0-9])(?:web[\s-]?rips?|webrips?)(?![a-z0-9])/i },
  { source: 'hdtv', re: /(?<![a-z0-9])(?:hdtv|hdtvrip|dsr|dsrip|dvb|dvbrip)(?![a-z0-9])/i },
  { source: 'dvd', re: /(?<![a-z0-9])(?:dvd|dvdrip|dvd[59]|dvdr)(?![a-z0-9])/i },
  { source: 'sdtv', re: /(?<![a-z0-9])(?:sdtv|pdtv|tvrip)(?![a-z0-9])/i },
  // Bare "WEB" (scene shorthand for WEB-DL) last, so a title word like
  // "Web" never outranks an explicit HDTV/DVD tag.
  { source: 'webdl', re: /(?<![a-z0-9])web(?![a-z0-9])/i },
];

/** Source a release advertises (best one if several), or null. */
export function parseSource(name: string | null | undefined): ReleaseSource | null {
  if (!name) return null;
  const text = normalise(name);
  // "WEBRip" is never read as bare "WEB": the lookahead refuses "web"
  // followed by letters.
  for (const { source, re } of SOURCE_PATTERNS) if (re.test(text)) return source;
  return null;
}

export interface TierDef {
  id: string;
  name: string;
  rank: number | null;
}

interface ParsedTier extends TierDef {
  resolution: number | null;
  source: ReleaseSource | null;
}

/** Resolutions with no tier of their own fall back to the nearest one we ship. */
const RESOLUTION_FALLBACK: Record<number, number[]> = {
  576: [480],
  4320: [2160],
};

/** A source with no exact tier at that resolution borrows the next-best source's tier. */
const SOURCE_FALLBACK: Partial<Record<ReleaseSource, ReleaseSource[]>> = {
  remux: ['bluray'],
};

export interface TierMatch {
  tier: TierDef | null;
  resolution: number | null;
  source: ReleaseSource | null;
  /** How the tier was picked - surfaced by the test box. */
  via: 'exact' | 'source-fallback' | 'resolution' | 'source-only' | 'name' | 'none';
}

/**
 * Map a release name onto one of `tiers`.
 *
 * 1. parse resolution + source independently
 * 2. exact (resolution, source) tier, e.g. 1080p + webdl -> "WEBDL-1080p"
 * 3. same resolution, fallback source (remux -> Bluray tier when no Remux-720p)
 * 4. bare resolution tier ("1080p") - unknown or unmapped source
 * 5. no resolution: a source-only tier ("DVD", "SDTV"; HDTV w/o res -> SDTV)
 * 6. legacy: literal tier-name substring match, highest rank (keeps
 *    user-added oddball tiers working)
 */
export function matchTier(name: string, tiers: TierDef[]): TierMatch {
  const resolution = parseResolution(name);
  const source = parseSource(name);
  const parsed: ParsedTier[] = tiers.map(t => ({ ...t, resolution: parseResolution(t.name), source: parseSource(t.name) }));

  const resolutions = resolution == null ? [] : [resolution, ...(RESOLUTION_FALLBACK[resolution] ?? [])];
  for (const res of resolutions) {
    const atRes = parsed.filter(t => t.resolution === res);
    if (!atRes.length) continue;
    if (source) {
      const exact = atRes.find(t => t.source === source);
      if (exact) return { tier: exact, resolution, source, via: 'exact' };
      for (const fb of SOURCE_FALLBACK[source] ?? []) {
        const hit = atRes.find(t => t.source === fb);
        if (hit) return { tier: hit, resolution, source, via: 'source-fallback' };
      }
    }
    const bare = atRes.find(t => t.source == null);
    if (bare) return { tier: bare, resolution, source, via: 'resolution' };
  }

  if (resolution == null && source) {
    const want: ReleaseSource[] = source === 'hdtv' ? ['hdtv', 'sdtv'] : [source];
    for (const s of want) {
      const hit = parsed.find(t => t.resolution == null && t.source === s);
      if (hit) return { tier: hit, resolution, source, via: 'source-only' };
    }
  }

  const lower = name.toLowerCase();
  let best: TierDef | null = null;
  for (const t of tiers) {
    if (lower.includes(t.name.toLowerCase()) && (best == null || (t.rank ?? 0) > (best.rank ?? 0))) best = t;
  }
  if (best) return { tier: best, resolution, source, via: 'name' };
  return { tier: null, resolution, source, via: 'none' };
}

/** Highest-ranked tier at a resolution (any source) - used when the source can't be known. */
export function topTierAtResolution(resolution: number | null, tiers: TierDef[]): TierDef | null {
  if (resolution == null) return null;
  let best: TierDef | null = null;
  for (const t of tiers) {
    if (parseResolution(t.name) !== resolution) continue;
    if (best == null || (t.rank ?? 0) > (best.rank ?? 0)) best = t;
  }
  return best;
}
