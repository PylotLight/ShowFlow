import { BaseProvider } from './base';
import { limiter } from '../core/limiter';
import { debugLog } from '../core/debug';
import type { Show, Episode, IMetadataProvider, EpisodeQuery, Season } from '../core/types';

export class TVDBProvider extends BaseProvider implements IMetadataProvider {
  name = 'tvdb';
  // TVDB v4 lives at api4.thetvdb.com - NOT api.thetvdb.com (that host either
  // 404s or serves something else entirely, which is why auth was failing).
  protected apiBaseUrl = 'https://api4.thetvdb.com/v4';

  private pin: string = '';

  constructor(config: any = {}) {
    super(config);
    this.apiKey = config?.apiKeys?.tvdb || process.env.TVDB_API_KEY || '';
    this.pin = config?.apiKeys?.tvdb_pin || process.env.TVDB_PIN || '';
  }

  private token: string | null = null;
  private tokenExpiry: number = 0;

  private async authenticate() {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    // TVDB v4 auth endpoint is POST /login (not /auth/token), and the body
    // key is lowercase `apikey` (not `apiKey`). `pin` is required in the
    // payload even when empty.
    const response = await fetch(`${this.apiBaseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ apikey: this.apiKey, pin: this.pin }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(
        `TVDB Auth failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}`
      );
    }

    // Response shape is { data: { token: "..." }, status: "success" }
    const payload = (await response.json()) as { data?: { token?: string }; token?: string };
    const token = payload.data?.token ?? payload.token;

    if (!token) {
      throw new Error('TVDB Auth succeeded but no token was found in the response');
    }

    this.token = token;
    // TVDB tokens are valid ~1 month; refresh a bit early to be safe rather
    // than assuming a 1-hour window that doesn't match reality.
    this.tokenExpiry = Date.now() + 20 * 24 * 3600 * 1000;
    return this.token;
  }

  protected override async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await this.authenticate();

    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('accept', 'application/json');

    // Call super.fetch but with the updated headers. Auth tokens aren't part
    // of the cache key (cacheKey() only looks at endpoint+body), so cached
    // responses are correctly reused across token refreshes.
    return super.fetch(endpoint, { ...options, headers });
  }

  private resolveEnglishName(item: any): string {
    if (!item) return '';
    
    // If we are using the /en translated endpoint, the 'name' field itself 
    // should already be the English version.
    if (item.name && !item.nameTranslations && !item.translations) {
       return item.name;
    }

    debugLog('Resolving English name for TVDB item', { 
      name: item.name, 
      nameTranslations: item.nameTranslations, 
      translations: item.translations,
      aliases: item.aliases 
    });

    const translation = (
      item.nameTranslations?.find((t: any) => t.language === 'en' || t.language === 'eng')?.name ||
      item.translations?.nameTranslations?.find((t: any) => t.language === 'en' || t.language === 'eng')?.name ||
      item.translations?.en ||
      item.translations?.eng ||
      item.aliases?.find((a: any) => a.language === 'en' || a.language === 'eng')?.name
    );

    if (translation) return translation;
    
    return item.name || '';
  }

  override async searchShow(query: string): Promise<Show[]> {
    // TVDB v4 wraps results in `data`, not `results`.
    const data = await this.fetch<{ data: any[] }>(
      `/search?query=${encodeURIComponent(query)}&type=series`
    );

    return (data.data ?? []).map(item => ({
      id: item.tvdb_id.toString(),
      title: this.resolveEnglishName(item),
      year: item.first_air_time ? parseInt(item.first_air_time.substring(0, 4)) : undefined,
      provider: this.name,
      normalizedId: item.tvdb_id.toString(),
      metadata: {
        ...item,
        englishName: this.resolveEnglishName(item),
      }
    }));
  }

  override async getShow(id: string): Promise<Show> {
    const response = await this.fetch<{ data: any }> (`/series/${id}/extended?meta=translations`);
    const item = response.data;

    if (!item) {
      debugLog('TVDBProvider: item not found', { id });
      throw new Error(`TVDBProvider: show not found for ID ${id}`);
    }

    return {
      id: item.id.toString(),
      title: this.resolveEnglishName(item),
      originalTitle: item.name,
      romanizedTitle: item.slug?.replace(/-/g, ' '),
      year: item.year ? parseInt(item.year.substring(0, 4)) : undefined,
      provider: this.name,
      normalizedId: item.id.toString(),
      metadata: {
        ...item,
        englishName: this.resolveEnglishName(item),
      }
    };
  }

  override async getSeasons(showId: string): Promise<Season[]> {
    const response = await this.fetch<{ data: any }>(`/series/${showId}/extended?meta=translations`);
    const item = response.data;

    if (!item || !item.seasons) {
      return [];
    }

    const seasons = await Promise.all(item.seasons.map(async (s: any) => {
      const translation = await this.getSeasonTranslation(s.id.toString());
      return {
        id: s.id.toString(),
        number: s.number,
        name: translation || this.resolveEnglishName(s),
        metadata: s,
      };
    }));

    return seasons;
  }

  override async getEpisodes(showId: string, seasonNumber?: number): Promise<Episode[]> {
    const episodes = await this.fetchEpisodesList(showId);

    const mapped = episodes.map((match: any) => ({
      season: match.seasonNumber,
      episode: match.number,
      absoluteNumber: match.absoluteNumber ?? undefined,
      title: match.name || this.resolveEnglishName(match),
      airDate: match.aired,
      metadata: match,
    }));

    if (seasonNumber !== undefined) {
      return mapped.filter(e => e.season === seasonNumber);
    }

    return mapped;
  }

  override async getEpisode(showId: string, episodeInfo: EpisodeQuery): Promise<Episode> {
    if (episodeInfo.season != null && episodeInfo.episode != null) {
      return this.getEpisodeBySeasonEpisode(showId, episodeInfo.season, episodeInfo.episode);
    }

    if (episodeInfo.absoluteNumber != null) {
      return this.getEpisodeByAbsolute(showId, episodeInfo.absoluteNumber);
    }

    throw new Error('TVDBProvider.getEpisode requires either {season, episode} or {absoluteNumber}');
  }

  private async fetchEpisodesList(showId: string): Promise<any[]> {
    let episodes: any[] = [];
    let page = 0;

    while (true) {
      // Use the translated endpoint to get English titles by default.
      // Note: TVDB uses 'eng' for English.
      const data = await this.fetch<any>(`/series/${showId}/episodes/default/eng?page=${page}`);
      const pageEpisodes: any[] = data.data?.episodes ?? data.episodes ?? [];
      episodes = episodes.concat(pageEpisodes);

      const hasNext = Boolean(data.links?.next ?? data.data?.links?.next);
      if (!hasNext || pageEpisodes.length === 0 || page > 20) break;
      page++;
    }

    return episodes;
  }

  private async getEpisodeTranslation(episodeId: string, lang: string = 'eng'): Promise<string | null> {
    try {
      const response = await this.fetch<{ data: any }>(`/episodes/${episodeId}/translations/${lang}`);
      return response.data?.name || null;
    } catch {
      return null;
    }
  }

  private async getSeasonTranslation(seasonId: string, lang: string = 'eng'): Promise<string | null> {
    try {
      const response = await this.fetch<{ data: any }>(`/seasons/${seasonId}/translations/${lang}`);
      return response.data?.name || null;
    } catch {
      return null;
    }
  }

  async getArtworkTypes(): Promise<{ id: number; name: string }[]> {
    const data = await this.fetch<{ data: any[] }>('/artwork/types');
    return (data.data ?? []).map(t => ({ id: t.id, name: t.name }));
  }

  async getSeriesArtworks(seriesId: string, type?: number): Promise<any[]> {
    const params = new URLSearchParams({ lang: 'eng' });
    if (type !== undefined) params.set('type', String(type));
    const response = await this.fetch<{ data: any; status?: string }>(`/series/${seriesId}/artworks?${params}`);
    debugLog('TVDB getSeriesArtworks response', { seriesId, type, data: JSON.stringify(response).slice(0, 500) });
    if (Array.isArray(response.data)) return response.data;
    return response.data?.artworks ?? [];
  }

  private async getEpisodeBySeasonEpisode(showId: string, season: number, episode: number): Promise<Episode> {
    const episodes = await this.fetchEpisodesList(showId);
    const match = episodes.find((e) => e.seasonNumber === season && e.number === episode);

    if (!match) {
      throw new Error(`TVDBProvider: no episode found for S${season}E${episode} on show ${showId}`);
    }

    const translation = await this.getEpisodeTranslation(match.id.toString());

    return {
      season,
      episode,
      absoluteNumber: match.absoluteNumber ?? undefined,
      title: translation || this.resolveEnglishName(match),
      airDate: match.aired,
      metadata: match
    };
  }

  private async getEpisodeByAbsolute(showId: string, absolute: number): Promise<Episode> {
    const episodes = await this.fetchEpisodesList(showId);
    const match = episodes.find((e) => e.absoluteNumber === absolute);

    if (!match) {
      throw new Error(`TVDBProvider: no episode found with absolute number ${absolute} for show ${showId}`);
    }

    const translation = await this.getEpisodeTranslation(match.id.toString());

    return {
      season: match.seasonNumber,
      episode: match.number,
      absoluteNumber: absolute,
      title: translation || this.resolveEnglishName(match),
      airDate: match.aired,
      metadata: match
    };
  }
}
