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

      const rawTitle = this.extractHtmlValue(item, /<title>([^<]*)<\/title>/);
      const title = this.decodeXmlEntities(rawTitle);
      const guid = this.extractHtmlValue(item, /<guid[^>]*>([^<]*)<\/guid>/);
      const link = this.extractHtmlValue(item, /<link>([^<]*)<\/link>/);
      const pubDate = this.extractHtmlValue(item, /<pubDate>([^<]*)<\/pubDate>/);

      if (!title || !guid) continue;

      // Nyaa's RSS namespace carries the real structured data - description
      // text is not a reliable source anymore (Nyaa dropped the old
      // "Seeders: X, Leechers: Y" description format some time ago).
      const infoHash = this.extractHtmlValue(item, /<nyaa:infoHash>([^<]*)<\/nyaa:infoHash>/);
      const seeders = this.extractHtmlValue(item, /<nyaa:seeders>([^<]*)<\/nyaa:seeders>/);
      const leechers = this.extractHtmlValue(item, /<nyaa:leechers>([^<]*)<\/nyaa:leechers>/);
      const sizeStr = this.extractHtmlValue(item, /<nyaa:size>([^<]*)<\/nyaa:size>/);
      const categoryName = this.decodeXmlEntities(
        this.extractHtmlValue(item, /<nyaa:category>([^<]*)<\/nyaa:category>/)
      );

      if (!infoHash) continue; // no valid infoHash means we can't build a usable magnet

      const magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
      const size = this.parseSize(sizeStr);
      const ageHours = this.ageFromIso(pubDate);

      results.push({
        guid,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders: seeders ? parseInt(seeders, 10) : 0,
        leechers: leechers ? parseInt(leechers, 10) : 0,
        grabs: 0,
        size,
        publishDate: pubDate,
        ageHours,
        infoUrl: guid,
        downloadUrl: link || magnetUrl,
        magnetUrl,
        infoHash,
        protocol: 'torrent',
        categories: [{ id: 5070, name: categoryName || 'Anime' }],
        indexerFlags: [],
        isPack: this.isPack(title),
      });
    }

    return results;
  }

  /**
   * Decode the handful of XML entities Nyaa titles commonly contain
   * (e.g. "SweetSub&amp;LoliHouse" -> "SweetSub&LoliHouse").
   */
  private decodeXmlEntities(str: string): string {
    if (!str) return str;
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'");
  }
}
