import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

/**
 * The Pirate Bay indexer - HTML scrape of search results.
 * Search URL: https://thepiratebay.org/search/QUERY/0/99/0
 */
export class TPBIndexer extends BaseNativeIndexer {
  name = 'The Pirate Bay';

  constructor(baseUrl?: string) {
    super('tpb', baseUrl, 2000);
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const searchQuery = encodeURIComponent(query);
    const url = `${this.baseUrl}/search/${searchQuery}/0/99/0`;

    const html = await this.fetchHtml(url);
    return this.parseHtml(html);
  }

  private parseHtml(html: string): IndexerResult[] {
    const results: IndexerResult[] = [];

    const rowRegex = /<tr>([\s\S]*?)<\/tr>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[1];
      if (!row || !row.includes('<a href="/torrent/')) continue;

      const nameMatch = row.match(/<a[^>]*href="\/torrent\/[^"]*"[^>]*>([^<]*)<\/a>/);
      const title = nameMatch?.[1]?.trim();
      if (!title) continue;

      const magnetMatch = row.match(/<a[^>]*href="(magnet:[^"]*)"[^>]*>/);
      const magnetUrl = magnetMatch?.[1] ?? '';

      const infoHash = magnetUrl.match(/btih:([a-fA-F0-9]+)/)?.[1] ?? '';

      const linkMatch = row.match(/<a[^>]*href="(\/torrent\/[^"]*)"[^>]*>/);
      const link = linkMatch?.[1] ?? '';
      const downloadUrl = link ? `${this.baseUrl}${link}` : '';
      const infoUrl = downloadUrl;

      const sizeFull = row.match(/Size\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)/i);
      const size = sizeFull ? this.parseSize(`${sizeFull[1]} ${sizeFull[2]}`) : 0;

      const seeders = this.extractRowNumber(row, 'seeders', 'td');
      const leechers = this.extractRowNumber(row, 'leechers', 'td');

      const ageStr = row.match(/Uploaded\s*([^<,]+)/i)?.[1]?.trim() ?? '';
      const ageHours = this.parseAgeToHours(ageStr);

      const isAnime = /anime|sub|dub|japan/i.test(title);

      results.push({
        guid: `tpb-${infoHash || title}`,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders,
        leechers,
        grabs: 0,
        size,
        publishDate: ageStr,
        ageHours,
        infoUrl,
        downloadUrl,
        magnetUrl,
        infoHash,
        protocol: 'torrent',
        categories: [{ id: isAnime ? 5070 : 5000, name: isAnime ? 'Anime' : 'TV' }],
        indexerFlags: [],
        isPack: this.isPack(title),
      });
    }

    return results;
  }

  private extractRowNumber(row: string, label: string, tag: string): number {
    const match = row.match(new RegExp(`${label}[^<]*<${tag}[^>]*>\\s*(\\d+)\\s*<`, 'i'));
    return match ? parseInt(match[1]!, 10) : 0;
  }
}
