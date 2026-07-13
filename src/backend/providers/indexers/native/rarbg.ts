import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

/**
 * TheRARBG indexer - HTML scrape of search results.
 * Search URL: https://therarbg.to/torrents.php?search=QUERY
 */
export class RarbgIndexer extends BaseNativeIndexer {
  name = 'TheRARBG';

  constructor(baseUrl?: string) {
    super('rarbg', baseUrl, 2000);
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const searchQuery = encodeURIComponent(query);
    const url = `${this.baseUrl}/torrents.php?search=${searchQuery}`;

    const html = await this.fetchHtml(url);
    return this.parseHtml(html);
  }

  private parseHtml(html: string): IndexerResult[] {
    const results: IndexerResult[] = [];

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const row = rowMatch[1];
      if (!row) continue;
      if (!row.includes('torrents_table') && !row.includes('/torrent/') && !row.includes('/download')) continue;

      const nameLinkMatch = row.match(/<a[^>]*href="(\/torrent\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const title = nameLinkMatch?.[2]?.replace(/<[^>]*>/g, '').trim();
      if (!title) continue;

      const link = nameLinkMatch?.[1] ?? '';

      const downloadLinkMatch = row.match(/<a[^>]*href="(\/download\/[^"]*)"[^>]*>/i);
      const downloadPath = downloadLinkMatch?.[1] ?? link;
      const downloadUrl = downloadPath.startsWith('http') ? downloadPath : `${this.baseUrl}${downloadPath}`;

      const magnetMatch = row.match(/href="(magnet:[^"]*)"/i);
      const magnetUrl = magnetMatch?.[1] ?? '';

      const infoHash = magnetUrl.match(/btih:([a-fA-F0-9]+)/)?.[1] ?? '';

      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]!.replace(/<[^>]*>/g, '').trim());

      const sizeStr = cells.find(c => /[\d.]+\s*(B|KB|KiB|MB|MiB|GB|GiB)/i.test(c)) || '';
      const size = this.parseSize(sizeStr);

      const seeders = this.extractFirstNumber(cells.find(c => /^\d+$/.test(c)) || '0');
      const leechers = this.extractFirstNumber(cells.find(c => /^\d+$/.test(c)) || '0');

      const isAnime = /anime|sub|dub|japan/i.test(title);

      results.push({
        guid: `rarbg-${infoHash || title.slice(0, 40)}`,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders,
        leechers,
        grabs: 0,
        size,
        publishDate: new Date().toISOString(),
        ageHours: 0,
        infoUrl: downloadUrl,
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

  private extractFirstNumber(str: string): number {
    const match = str.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }
}
