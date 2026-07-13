import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

/**
 * Nyaa.si indexer - uses RSS feed for search.
 * RSS endpoint: https://nyaa.si/?page=rss&q=QUERY&c=CATEGORY
 *
 * Categories mapped to Torznab:
 *   1_2 (English subtitled anime)  -> 5070 (Anime)
 */
export class NyaaSiIndexer extends BaseNativeIndexer {
  name = 'Nyaa.si';

  constructor(baseUrl?: string) {
    super('nyaa', baseUrl, 1000);
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const searchQuery = encodeURIComponent(query);
    const cat = '1_2';
    const url = `${this.baseUrl}/?page=rss&q=${searchQuery}&c=${cat}`;

    const rss = await this.fetchRss(url);
    return this.parseRss(rss);
  }

  private parseRss(xml: string): IndexerResult[] {
    const results: IndexerResult[] = [];

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let itemMatch: RegExpExecArray | null;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const item = itemMatch[1];
      if (!item) continue;

      const title = this.extractHtmlValue(item, /<title>([^<]*)<\/title>/);
      const guid = this.extractHtmlValue(item, /<guid[^>]*>([^<]*)<\/guid>/);
      const link = this.extractHtmlValue(item, /<link>([^<]*)<\/link>/);
      const pubDate = this.extractHtmlValue(item, /<pubDate>([^<]*)<\/pubDate>/);
      const description = this.extractHtmlValue(item, /<description>([^<]*)<\/description>/);

      if (!title || !guid) continue;

      const infoHash = guid.replace(/https?:\/\/[^\/]+\/view\//, '').replace(/^.*[\/\\]/, '');
      const magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;

      const sizeMatch = description.match(/([\d.]+)\s*(KiB|MiB|GiB|TiB)/i);
      let size = 0;
      if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]!);
        const unit = sizeMatch[2]!.toUpperCase();
        const multipliers: Record<string, number> = { KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
        size = Math.round(num * (multipliers[unit] ?? 1));
      }

      const seedersMatch = description.match(/Seeders:\s*(\d+)/i);
      const leechersMatch = description.match(/Leechers:\s*(\d+)/i);

      const ageHours = this.ageFromIso(pubDate);

      results.push({
        guid,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders: seedersMatch ? parseInt(seedersMatch[1]!, 10) : 0,
        leechers: leechersMatch ? parseInt(leechersMatch[1]!, 10) : 0,
        grabs: 0,
        size,
        publishDate: pubDate,
        ageHours,
        infoUrl: guid,
        downloadUrl: link || magnetUrl,
        magnetUrl,
        infoHash,
        protocol: 'torrent',
        categories: [{ id: 5070, name: 'Anime' }],
        indexerFlags: [],
        isPack: this.isPack(title),
      });
    }

    return results;
  }
}
