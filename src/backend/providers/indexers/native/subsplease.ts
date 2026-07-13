import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

/**
 * SubsPlease indexer - uses RSS feed for latest releases.
 * RSS endpoint: https://subsplease.org/rss/
 *
 * SubsPlease has no built-in search, so we fetch the main RSS feed
 * and filter by title match client-side.
 */
export class SubsPleaseIndexer extends BaseNativeIndexer {
  name = 'SubsPlease';

  constructor(baseUrl?: string) {
    super('subsplease', baseUrl, 1500);
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const rssUrl = `${this.baseUrl}/rss/`;
    const rss = await this.fetchRss(rssUrl);
    const allResults = this.parseRss(rss);

    const terms = query.toLowerCase().split(/\s+/);

    return allResults.filter(r => {
      const lower = r.title.toLowerCase();
      return terms.every(t => lower.includes(t));
    });
  }

  private parseRss(xml: string): IndexerResult[] {
    const results: IndexerResult[] = [];

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let itemMatch: RegExpExecArray | null;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const item = itemMatch[1];
      if (!item) continue;

      const title = this.extractHtmlValue(item, /<title>([^<]*)<\/title>/);
      const link = this.extractHtmlValue(item, /<link>([^<]*)<\/link>/);
      const pubDate = this.extractHtmlValue(item, /<pubDate>([^<]*)<\/pubDate>/);
      const guid = this.extractHtmlValue(item, /<guid[^>]*>([^<]*)<\/guid>/);

      if (!title || !link) continue;

      const ageHours = this.ageFromIso(pubDate);

      const magnetUrl = link.startsWith('magnet:') ? link : '';

      const publishDateVal = typeof pubDate === 'string' ? pubDate : '';
      results.push({
        guid: guid || link,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders: 0,
        leechers: 0,
        grabs: 0,
        size: 0,
        publishDate: publishDateVal,
        ageHours,
        infoUrl: link,
        downloadUrl: link,
        magnetUrl,
        infoHash: '',
        protocol: 'torrent',
        categories: [{ id: 5000, name: 'TV' }],
        indexerFlags: [],
        isPack: this.isPack(title),
      });
    }

    return results;
  }
}
