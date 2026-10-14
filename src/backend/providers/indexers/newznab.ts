import type { IndexerCategory, IndexerProtocol, IndexerResult } from './types';

/**
 * Minimal newznab / torznab feed parser - the XML shape every *arr-style
 * indexer (and Prowlarr's per-indexer `/{id}/api` proxy) answers with for
 * `t=search` / `t=tvsearch`. Used by RSS sync, where we pull the indexer's
 * "latest releases" listing (no `q`) instead of searching per episode.
 *
 * Regex-based on purpose (same approach as the native Nyaa/SubsPlease
 * parsers) - the feeds are flat and we only need a handful of fields.
 */

export class NewznabError extends Error {
  constructor(public code: string, description: string) {
    super(`newznab error ${code}: ${description}`);
  }
}

const ENTITY_MAP: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(str: string): string {
  if (!str) return str;
  const cdata = str.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1]!.trim();
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITY_MAP[e]!)
    .trim();
}

function tag(item: string, name: string): string {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]!) : '';
}

function attrOf(el: string, name: string): string {
  const m = el.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) ?? el.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? decodeXml(m[1]!) : '';
}

/** All `<newznab:attr>` / `<torznab:attr>` name/value pairs (multi-valued, e.g. category). */
function nzAttrs(item: string): { attrs: Map<string, string[]>; torznab: boolean } {
  const attrs = new Map<string, string[]>();
  let torznab = false;
  for (const m of item.matchAll(/<(newznab|torznab):attr\b([^>]*?)\/?>/gi)) {
    if (m[1]!.toLowerCase() === 'torznab') torznab = true;
    const name = attrOf(m[2]!, 'name').toLowerCase();
    const value = attrOf(m[2]!, 'value');
    if (!name) continue;
    const list = attrs.get(name) ?? [];
    list.push(value);
    attrs.set(name, list);
  }
  return { attrs, torznab };
}

function num(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface ParseFeedOptions {
  indexerId: number;
  indexerName: string;
  /** Force a protocol when the caller already knows it (Prowlarr tells us per indexer). */
  protocol?: IndexerProtocol;
  nowMs?: number;
}

/**
 * Parse a newznab/torznab RSS response into IndexerResults. Throws
 * NewznabError when the indexer answered with an `<error code=.../>` body
 * (bad api key, unsupported function, rate limit...).
 */
export function parseNewznabFeed(xml: string, opts: ParseFeedOptions): IndexerResult[] {
  const err = xml.match(/<error\b([^>]*)\/?>/i);
  if (err && !/<item\b/i.test(xml)) {
    throw new NewznabError(attrOf(err[1]!, 'code') || '?', attrOf(err[1]!, 'description') || 'unknown error');
  }

  const now = opts.nowMs ?? Date.now();
  const results: IndexerResult[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1]!;
    const title = tag(item, 'title');
    if (!title) continue;

    const { attrs, torznab } = nzAttrs(item);
    const a = (k: string) => attrs.get(k)?.[0] ?? '';

    const enclosure = item.match(/<enclosure\b([^>]*?)\/?>/i)?.[1] ?? '';
    const encUrl = attrOf(enclosure, 'url');
    const encType = attrOf(enclosure, 'type').toLowerCase();
    const encLen = num(attrOf(enclosure, 'length'));

    const link = tag(item, 'link');
    const guid = tag(item, 'guid') || a('guid') || link || encUrl;
    const pubDate = tag(item, 'pubDate') || a('usenetdate');
    const pubMs = pubDate ? Date.parse(pubDate) : NaN;

    const magnetAttr = a('magneturl');
    const magnetUrl = magnetAttr.startsWith('magnet:') ? magnetAttr
      : link.startsWith('magnet:') ? link
      : encUrl.startsWith('magnet:') ? encUrl : '';
    const downloadUrl = encUrl && !encUrl.startsWith('magnet:') ? encUrl : (link && !link.startsWith('magnet:') ? link : '');
    const infoHash = (a('infohash') || magnetUrl.match(/btih:([a-z0-9]+)/i)?.[1] || '').toLowerCase();

    const protocol: IndexerProtocol = opts.protocol && opts.protocol !== 'unknown'
      ? opts.protocol
      : (torznab || encType.includes('bittorrent') || magnetUrl) ? 'torrent'
      : encType.includes('nzb') || attrs.has('usenetdate') || attrs.has('poster') ? 'usenet'
      : 'unknown';

    const categories: IndexerCategory[] = [];
    for (const c of attrs.get('category') ?? []) {
      const id = parseInt(c, 10);
      if (Number.isFinite(id) && !categories.some(x => x.id === id)) categories.push({ id, name: '' });
    }
    if (categories.length === 0) {
      for (const cm of item.matchAll(/<category>([^<]*)<\/category>/gi)) {
        const id = parseInt(cm[1]!, 10);
        if (Number.isFinite(id)) categories.push({ id, name: '' });
      }
    }

    const seeders = num(a('seeders'));
    const peers = num(a('peers'));
    results.push({
      guid,
      indexerId: opts.indexerId,
      indexerName: opts.indexerName,
      title,
      seeders,
      leechers: Math.max(0, peers - seeders),
      grabs: num(a('grabs')),
      size: num(tag(item, 'size')) || num(a('size')) || encLen,
      publishDate: Number.isFinite(pubMs) ? new Date(pubMs).toISOString() : pubDate,
      ageHours: Number.isFinite(pubMs) ? Math.max(0, (now - pubMs) / 3_600_000) : 0,
      infoUrl: tag(item, 'comments') || (guid.startsWith('http') ? guid : ''),
      downloadUrl,
      magnetUrl,
      infoHash,
      protocol,
      categories,
      indexerFlags: [],
      isPack: /\b(?:pack(?:s)?|complete|season)\b|\bS\d{1,2}\b(?!E)/i.test(title),
    });
  }
  return results;
}
