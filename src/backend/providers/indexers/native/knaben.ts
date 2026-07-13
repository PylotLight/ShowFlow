import type { IndexerResult, SearchOptions } from '../types';
import { BaseNativeIndexer } from './base';

interface KnabenHit {
  title: string;
  bytes: number;
  seeders: number;
  peers: number;
  hash: string | null;
  magnetUrl: string | null;
  link: string | null;
  date: string;
  category: string;
  categoryId: number[];
  tracker: string;
  trackerId: string;
  virusDetection: number;
  id: string;
  details: string | null;
}

interface KnabenResponse {
  max_score: number | null;
  total: { relation: string; value: number };
  hits: KnabenHit[];
}

export class KnabenIndexer extends BaseNativeIndexer {
  name = 'Knaben';

  constructor(baseUrl?: string) {
    super('knaben', baseUrl, 1000);
  }

  protected override async doValidate(): Promise<{ ok: boolean; version?: string; message?: string }> {
    const data = await this.fetchPostJson<KnabenResponse>(this.baseUrl, {
      query: '',
      size: 1,
      hide_unsafe: true,
      hide_xxx: true,
    });
    const ok = data !== null && data !== undefined && data.hits !== undefined;
    return {
      ok,
      version: 'v1',
      message: ok ? `${this.name} API is reachable` : `${this.name} API returned empty response`,
    };
  }

  // From https://github.com/HorizonCode/knaben-searchplugin/blob/main/knaben.py
  private tvCategoryIds(): number[] {
    return [2000000, 2001000, 2002000, 2003000, 2004000, 2005000, 2006000, 2007000, 2008000];
  }

  private animeCategoryIds(): number[] {
    return [6000000, 6001000, 6002000, 6003000, 6004000, 6005000, 6006000, 6007000, 6008000];
  }

  protected override async doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const isAnime = options?.categories?.some(c => c === 5070);
    const categories = isAnime ? this.animeCategoryIds() : this.tvCategoryIds();

    const body: Record<string, unknown> = {
      query,
      search_type: '100%',
      search_field: 'title',
      order_by: 'date',
      order_direction: 'desc',
      categories,
      from: 0,
      size: 150,
      hide_unsafe: true,
      hide_xxx: true,
    };

    const data = await this.fetchPostJson<KnabenResponse>(this.baseUrl, body);
    return this.parseResponse(data);
  }

  private parseResponse(data: KnabenResponse): IndexerResult[] {
    const results: IndexerResult[] = [];

    if (!data?.hits || !Array.isArray(data.hits)) return results;

    for (const item of data.hits) {
      const title = item.title ?? '';
      if (!title) continue;

      const infoHash = item.hash ?? '';
      const magnetUrl = item.magnetUrl ?? '';
      const downloadUrl = item.link ?? item.details ?? '';
      const publishDate = item.date ?? '';
      const isAnime = /anime/i.test(title) || (item.category && /anime/i.test(item.category));

      results.push({
        guid: `knaben-${item.id || infoHash || title.slice(0, 40)}`,
        indexerId: 1,
        indexerName: this.name,
        title,
        seeders: item.seeders ?? 0,
        leechers: item.peers ?? 0,
        grabs: 0,
        size: item.bytes ?? 0,
        publishDate,
        ageHours: this.ageFromIso(publishDate),
        infoUrl: downloadUrl || magnetUrl,
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
}
