import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

/**
 * SubsPlease indexer - uses RSS feed for latest releases.
 * RSS endpoint: https://subsplease.org/rss/?r=<resolution>
 *   resolution: 'sd' | '720' | '1080' | '' (all resolutions, mixed)
 *
 * Note: SubsPlease also has an undocumented JSON search API
 * (https://subsplease.org/api/?f=search&tz=<tz>&s=<query>) that returns
 * structured per-resolution magnet links without needing RSS + title
 * substring matching. Worth migrating to if this feed proves flaky.
 *
 * SubsPlease has no built-in search on the RSS feed itself, so we fetch
 * a single resolution's feed and filter by title match client-side.
 */
export class SubsPleaseIndexer extends BaseNativeIndexer {
  name = 'SubsPlease';

  /** Default resolution for the RSS feed - matches the site's own default. */
  private readonly resolution = '1080';

  constructor(baseUrl?: string) {
    super('subsplease', baseUrl, 1500);
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const rssUrl = `${this.baseUrl}/rss/?r=${this.resolution}`;
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
