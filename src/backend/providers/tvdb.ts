import { BaseProvider } from './base';
import { debugLog } from '../core/debug';
import type {
  Episode,
  EpisodeQuery,
  IMetadataProvider,
  Season,
  Show,
} from '../core/types';

type TvdbTitleEntry = {
  name?: string;
  title?: string;
  language?: string;
  lang?: string;
  value?: string;
};

type TvdbSeries = {
  id?: number | string;
  tvdb_id?: number | string;
  name?: string;
  slug?: string;
  year?: string | number;
  first_air_time?: string;
  firstAired?: string;
  aliases?: Array<string | TvdbTitleEntry>;
  nameTranslations?: TvdbTitleEntry[];
  translations?: {
    nameTranslations?: TvdbTitleEntry[];
    [key: string]: unknown;
  };
  seasons?: Array<{
    id: number | string;
    number: number;
    name?: string;
    [key: string]: unknown;
  }>;
  airsTime?: string;
  [key: string]: unknown;
};

type TvdbEpisode = {
  id: number | string;
  seasonNumber: number;
  number: number;
  absoluteNumber?: number | null;
  name?: string;
  aired?: string;
  [key: string]: unknown;
};

export interface TvdbArtwork {
  id?: number | string;
  type: number;
  image: string;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
  language?: string | null;
  score?: number | null;
  [key: string]: unknown;
}

type TvdbArtworkResponse = {
  data?: TvdbArtwork[] | {
    artworks?: TvdbArtwork[];
  };
};


type ExtendedSeriesResponse = {
  data?: TvdbSeries;
};

type SearchResponse = {
  data?: TvdbSeries[];
};

type EpisodeListResponse = {
  data?: {
    episodes?: TvdbEpisode[];
    links?: {
      next?: unknown;
    };
  };
  episodes?: TvdbEpisode[];
  links?: {
    next?: unknown;
  };
};

interface ShowWithTitles extends Show {
  aliases?: string[];
  alternateTitles?: string[];
  translations?: Record<string, string>;
}

export class TVDBProvider extends BaseProvider implements IMetadataProvider {
  name = 'tvdb';

  protected apiBaseUrl = 'https://api4.thetvdb.com/v4';

  private token: string | null = null;
  private tokenExpiry = 0;
  private pin = '';

  constructor(config: Record<string, unknown> = {}) {
    super(config);

    const apiKeys = config.apiKeys as Record<string, string> | undefined;

    this.apiKey = apiKeys?.tvdb ?? process.env.TVDB_API_KEY ?? '';
    this.pin = apiKeys?.tvdb_pin ?? process.env.TVDB_PIN ?? '';
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    const response = await fetch(`${this.apiBaseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        apikey: this.apiKey,
        pin: this.pin,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      throw new Error(
        `TVDB authentication failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
      );
    }

    const payload = await response.json() as {
      data?: { token?: string };
      token?: string;
    };

    const token = payload.data?.token ?? payload.token;

    if (!token) {
      throw new Error(
        'TVDB authentication succeeded but no token was returned.',
      );
    }

    this.token = token;

    // TVDB tokens last substantially longer than a normal short-lived access
    // token. Refresh early rather than relying on an expired token response.
    this.tokenExpiry = Date.now() + 20 * 24 * 60 * 60 * 1000;

    return token;
  }

  protected override async fetch<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.authenticate();
    const headers = new Headers(options.headers);

    headers.set('Authorization', `Bearer ${token}`);
    headers.set('accept', 'application/json');

    return super.fetch<T>(endpoint, {
      ...options,
      headers,
    });
  }

  override async searchShow(query: string): Promise<Show[]> {
    const response = await this.fetch<SearchResponse>(
      `/search?query=${encodeURIComponent(query)}&type=series`,
    );

    const results = response.data ?? [];

    /*
     * Search responses can omit the aliases/translations required to match
     * localized names. Hydrate a bounded result set so Oracle receives title
     * candidates that include TVDB's actual metadata.
     *
     * Do not hydrate unbounded results: TVDB's search endpoint can return many
     * loosely related series and each hydration is another authenticated call.
     */
    const hydratedResults = await Promise.all(
      results.slice(0, 10).map(async result => {
        const id = this.getSeriesId(result);

        if (!id) {
          return result;
        }

        try {
          const extended = await this.fetchExtendedSeries(id);
          return extended ?? result;
        } catch (error) {
          debugLog('TVDB search result hydration failed', {
            id,
            query,
            error: error instanceof Error ? error.message : String(error),
          });

          return result;
        }
      }),
    );

    const mapped = hydratedResults
      .map(item => this.mapSeriesToShow(item))
      .filter((show): show is ShowWithTitles => show !== null);

    debugLog('TVDB search completed', {
      query,
      searchResultCount: results.length,
      hydratedResultCount: mapped.length,
      results: mapped.slice(0, 10).map(show => ({
        id: show.id,
        title: show.title,
        originalTitle: show.originalTitle,
        romanizedTitle: show.romanizedTitle,
        aliases: show.aliases,
        alternateTitles: show.alternateTitles,
      })),
    });

    return mapped;
  }

  override async getShow(id: string): Promise<Show> {
    const seriesId = this.normalizeSeriesId(id);
    const item = await this.fetchExtendedSeries(seriesId);

    if (!item) {
      debugLog('TVDB show was not found', {
        id,
        normalizedId: seriesId,
      });
      throw new Error(`TVDB show was not found for ID ${seriesId}`);
    }

    const show = this.mapSeriesToShow(item);

    if (!show) {
      throw new Error(`TVDB returned invalid series data for ID ${seriesId}`);
    }

    return show;
  }


  override async getSeasons(showId: string): Promise<Season[]> {
    const seriesId = this.normalizeSeriesId(showId);
    const series = await this.fetchExtendedSeries(seriesId);

    if (!series?.seasons?.length) {
      return [];
    }

    const seasons = await Promise.all(
      series.seasons.map(async season => {
        const translation = await this.getSeasonTranslation(
          String(season.id),
        );

        return {
          id: String(season.id),
          number: season.number,
          name: translation || this.resolvePreferredName(season),
          metadata: season,
        };
      }),
    );

    return seasons;
  }

  override async getEpisodes(
    showId: string,
    seasonNumber?: number,
  ): Promise<Episode[]> {
    const seriesId = this.normalizeSeriesId(showId);

    const [episodes, series] = await Promise.all([
      this.fetchEpisodesList(seriesId),
      this.fetchExtendedSeries(seriesId).catch(() => null),
    ]);

    const mapped = episodes.map(episode =>
      this.mapEpisode(
        episode,
        this.resolveEpisodeName(episode),
        series?.airsTime,
      ),
    );

    return seasonNumber === undefined
      ? mapped
      : mapped.filter(episode => episode.season === seasonNumber);
  }

  override async getEpisode(
    showId: string,
    episodeInfo: EpisodeQuery,
  ): Promise<Episode> {
    const seriesId = this.normalizeSeriesId(showId);

    if (
      episodeInfo.season !== undefined &&
      episodeInfo.episode !== undefined
    ) {
      return this.getEpisodeBySeasonEpisode(
        seriesId,
        episodeInfo.season,
        episodeInfo.episode,
      );
    }

    if (episodeInfo.absoluteNumber !== undefined) {
      return this.getEpisodeByAbsolute(
        seriesId,
        episodeInfo.absoluteNumber,
      );
    }

    throw new Error(
      'TVDBProvider.getEpisode requires { season, episode } or { absoluteNumber }.',
    );
  }


  async getArtworkTypes(): Promise<Array<{ id: number; name: string }>> {
    const response = await this.fetch<{
      data?: Array<{ id: number; name: string }>;
    }>('/artwork/types');

    return response.data ?? [];
  }

  async getSeriesArtworks(
    seriesId: string,
    type?: number,
  ): Promise<TvdbArtwork[]> {
    const normalizedSeriesId = this.normalizeSeriesId(seriesId);

    const params = new URLSearchParams({
      lang: 'eng',
    });

    if (type !== undefined) {
      params.set('type', String(type));
    }

    const response = await this.fetch<TvdbArtworkResponse>(
      `/series/${normalizedSeriesId}/artworks?${params}`,
    );
    const artworks = Array.isArray(response.data)
      ? response.data
      : response.data?.artworks ?? [];

    const validArtworks = artworks.filter(
      (artwork): artwork is TvdbArtwork =>
        Boolean(
          artwork &&
          typeof artwork.type === 'number' &&
          typeof artwork.image === 'string' &&
          artwork.image.length > 0,
        ),
    );

    debugLog('TVDB series artwork response received', {
      seriesId,
      type,
      artworkCount: validArtworks.length,
      responsePreview: JSON.stringify(response).slice(0, 500),
    });

    return validArtworks;
  }


  private async fetchExtendedSeries(
    id: string,
  ): Promise<TvdbSeries | null> {
    const seriesId = this.normalizeSeriesId(id);

    const response = await this.fetch<ExtendedSeriesResponse>(
      `/series/${seriesId}/extended?meta=translations`,
    );

    return response.data ?? null;
  }


  private async fetchEpisodesList(showId: string): Promise<TvdbEpisode[]> {
    const seriesId = this.normalizeSeriesId(showId);
    const episodes: TvdbEpisode[] = [];
    let page = 0;
    let useDefaultEndpoint = false;

    debugLog('TVDB episode sync started', {
      showId,
      normalizedSeriesId: seriesId,
    });

    while (true) {
      const endpoint = useDefaultEndpoint
        ? `/series/${seriesId}/episodes/default?page=${page}`
        : `/series/${seriesId}/episodes/default/eng?page=${page}`;

      let response = await this.fetch<EpisodeListResponse>(endpoint);

      let pageEpisodes =
        response.data?.episodes ??
        response.episodes ??
        [];

      /*
       * TVDB's translated endpoint can return an empty result for a series
       * whose ordinary default episode order exists. Retry page zero without
       * the language suffix, then use that endpoint for every later page.
       */
      if (page === 0 && pageEpisodes.length === 0 && !useDefaultEndpoint) {
        const fallbackEndpoint =
          `/series/${seriesId}/episodes/default?page=${page}`;

        debugLog(
          'TVDB English episode endpoint returned no episodes; trying default endpoint',
          {
            showId,
            normalizedSeriesId: seriesId,
            endpoint,
            fallbackEndpoint,
          },
        );

        response = await this.fetch<EpisodeListResponse>(fallbackEndpoint);

        pageEpisodes =
          response.data?.episodes ??
          response.episodes ??
          [];

        useDefaultEndpoint = true;
      }

      episodes.push(...pageEpisodes);

      const nextPage =
        response.links?.next ??
        response.data?.links?.next;

      debugLog('TVDB episode page fetched', {
        showId,
        normalizedSeriesId: seriesId,
        endpoint: useDefaultEndpoint
          ? `/series/${seriesId}/episodes/default?page=${page}`
          : endpoint,
        page,
        pageEpisodeCount: pageEpisodes.length,
        totalEpisodeCount: episodes.length,
        hasNextPage: Boolean(nextPage),
      });

      if (!nextPage || pageEpisodes.length === 0 || page >= 100) {
        break;
      }

      page += 1;
    }

    debugLog('TVDB episode sync completed', {
      showId,
      normalizedSeriesId: seriesId,
      episodeCount: episodes.length,
      usedDefaultEndpoint: useDefaultEndpoint,
    });

    return episodes;
  }


  private async getEpisodeBySeasonEpisode(
    showId: string,
    season: number,
    episode: number,
  ): Promise<Episode> {
    const [episodes, series] = await Promise.all([
      this.fetchEpisodesList(showId),
      this.fetchExtendedSeries(showId).catch(() => null),
    ]);

    const match = episodes.find(
      item =>
        item.seasonNumber === season &&
        item.number === episode,
    );

    if (!match) {
      throw new Error(
        `TVDB episode was not found for show ${showId}, S${season}E${episode}.`,
      );
    }

    const translatedName = await this.getEpisodeTranslation(
      String(match.id),
    );

    return this.mapEpisode(
      match,
      translatedName || this.resolveEpisodeName(match),
      series?.airsTime,
    );
  }

  private async getEpisodeByAbsolute(
    showId: string,
    absoluteNumber: number,
  ): Promise<Episode> {
    const [episodes, series] = await Promise.all([
      this.fetchEpisodesList(showId),
      this.fetchExtendedSeries(showId).catch(() => null),
    ]);

    const match = episodes.find(
      item => item.absoluteNumber === absoluteNumber,
    );

    if (!match) {
      throw new Error(
        `TVDB absolute episode ${absoluteNumber} was not found for show ${showId}.`,
      );
    }

    const translatedName = await this.getEpisodeTranslation(
      String(match.id),
    );

    return this.mapEpisode(
      match,
      translatedName || this.resolveEpisodeName(match),
      series?.airsTime,
    );
  }

  private async getEpisodeTranslation(
    episodeId: string,
    language = 'eng',
  ): Promise<string | null> {
    try {
      const response = await this.fetch<{
        data?: {
          name?: string;
        };
      }>(`/episodes/${episodeId}/translations/${language}`);

      return response.data?.name?.trim() || null;
    } catch {
      return null;
    }
  }

  private async getSeasonTranslation(
    seasonId: string,
    language = 'eng',
  ): Promise<string | null> {
    try {
      const response = await this.fetch<{
        data?: {
          name?: string;
        };
      }>(`/seasons/${seasonId}/translations/${language}`);

      return response.data?.name?.trim() || null;
    } catch {
      return null;
    }
  }

  private mapSeriesToShow(item: TvdbSeries): ShowWithTitles | null {
    const id = this.getSeriesId(item);

    if (!id) {
      debugLog('TVDB search result did not include a usable series ID', {
        item,
      });
      return null;
    }

    const titles = this.extractSeriesTitles(item);
    const title =
      this.resolvePreferredName(item) ||
      titles[0] ||
      `TVDB Series ${id}`;

    const originalTitle =
      this.resolveOriginalName(item) ||
      undefined;

    const romanizedTitle = this.slugToTitle(item.slug);

    const aliases = this.uniqueTitles([
      ...titles,
      originalTitle,
      romanizedTitle,
    ]).filter(candidate => candidate !== title);

    const translations = this.extractNamedTranslations(item);

    return {
      id,
      title,
      originalTitle,
      romanizedTitle,
      year: this.extractYear(item),
      provider: this.name,
      normalizedId: id,

      /*
       * These optional fields are intentionally present in addition to the
       * core Show schema. Oracle can use them directly when matching external
       * provider results, and saveShow() can persist metadata for later local
       * resolution.
       */
      aliases,
      alternateTitles: aliases,
      translations,

      metadata: {
        ...item,
        aliases,
        alternateTitles: aliases,
        translations,
        englishName: title,
        originalName: originalTitle,
        romanizedName: romanizedTitle,
      },
    };
  }

  private mapEpisode(
    episode: TvdbEpisode,
    title: string,
    airsTime?: string,
  ): Episode {
    return {
      season: episode.seasonNumber,
      episode: episode.number,
      absoluteNumber: episode.absoluteNumber ?? undefined,
      title: title || undefined,
      airDate: this.buildAirDate(episode.aired, airsTime),
      airTime: airsTime || undefined,
      metadata: episode,
    };
  }

  private getSeriesId(item: TvdbSeries): string | null {
    const rawId = item.id ?? item.tvdb_id;

    if (rawId === undefined || rawId === null || rawId === '') {
      return null;
    }

    return this.normalizeSeriesId(rawId);
  }


  private normalizeSeriesId(id: string | number): string {
    const raw = String(id).trim();

    /*
     * Search endpoints may return IDs like:
     * - series-452039
     * - tvdb:452039
     * - 452039
     *
     * TVDB series endpoints require the numeric portion.
     */
    const numericMatch = raw.match(/(?:series-|tvdb:)?(\d+)$/i);

    if (numericMatch?.[1]) {
      return numericMatch[1];
    }

    return raw;
  }



  private resolvePreferredName(item: Record<string, unknown>): string {
    const translations = this.extractTranslationEntries(item);

    const english = translations.find(entry =>
      this.isEnglishLanguage(entry.language),
    )?.name;

    if (english?.trim()) {
      return english.trim();
    }

    const directEnglish =
      this.getString(item, 'englishName') ??
      this.getString(item, 'english_name');

    if (directEnglish?.trim()) {
      return directEnglish.trim();
    }

    const name = this.getString(item, 'name');

    if (name?.trim()) {
      return name.trim();
    }

    const alias = this.extractAliases(item)[0];

    return alias ?? '';
  }

  private resolveOriginalName(item: Record<string, unknown>): string {
    const directOriginal =
      this.getString(item, 'originalName') ??
      this.getString(item, 'original_name') ??
      this.getString(item, 'nativeName') ??
      this.getString(item, 'native_name');

    if (directOriginal?.trim()) {
      return directOriginal.trim();
    }

    const name = this.getString(item, 'name');

    return name?.trim() || '';
  }

  private resolveEpisodeName(episode: TvdbEpisode): string {
    return this.resolvePreferredName(episode) || episode.name || '';
  }

  private extractSeriesTitles(item: TvdbSeries): string[] {
    return this.uniqueTitles([
      item.name,
      this.slugToTitle(item.slug),
      ...this.extractAliases(item),
      ...this.extractTranslationEntries(item).map(entry => entry.name),
    ]);
  }

  private extractNamedTranslations(
    item: TvdbSeries,
  ): Record<string, string> {
    const translations: Record<string, string> = {};

    for (const entry of this.extractTranslationEntries(item)) {
      if (!entry.language || !entry.name) {
        continue;
      }

      translations[entry.language] = entry.name;
    }

    return translations;
  }

  private extractTranslationEntries(
    item: Record<string, unknown>,
  ): Array<{ language: string; name: string }> {
    const entries: Array<{ language: string; name: string }> = [];
    const seen = new Set<string>();

    const addEntry = (
      language: unknown,
      name: unknown,
    ): void => {
      if (typeof name !== 'string' || !name.trim()) {
        return;
      }

      const normalizedLanguage =
        typeof language === 'string' && language.trim()
          ? language.trim().toLowerCase()
          : 'unknown';

      const normalizedName = name.trim();
      const key = `${normalizedLanguage}:${normalizedName.toLocaleLowerCase()}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);

      entries.push({
        language: normalizedLanguage,
        name: normalizedName,
      });
    };

    const collectEntries = (value: unknown): void => {
      if (!value) {
        return;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') {
            addEntry('unknown', entry);
            continue;
          }

          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;

            addEntry(
              record.language ?? record.lang ?? record.languageCode,
              record.name ?? record.title ?? record.value,
            );
          }
        }

        return;
      }

      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;

        if (
          typeof record.name === 'string' ||
          typeof record.title === 'string'
        ) {
          addEntry(
            record.language ?? record.lang ?? record.languageCode,
            record.name ?? record.title,
          );
        }

        for (const [language, nestedValue] of Object.entries(record)) {
          if (typeof nestedValue === 'string') {
            addEntry(language, nestedValue);
          } else if (Array.isArray(nestedValue)) {
            collectEntries(nestedValue);
          }
        }
      }
    };

    collectEntries(item.nameTranslations);

    const translations = item.translations;

    if (translations && typeof translations === 'object') {
      const translationObject = translations as Record<string, unknown>;

      collectEntries(translationObject.nameTranslations);

      for (const [language, value] of Object.entries(translationObject)) {
        if (language === 'nameTranslations') {
          continue;
        }

        if (typeof value === 'string') {
          addEntry(language, value);
        }
      }
    }

    return entries;
  }

  private extractAliases(item: Record<string, unknown>): string[] {
    const aliases = item.aliases;
    const values: string[] = [];

    if (!Array.isArray(aliases)) {
      return values;
    }

    for (const alias of aliases) {
      if (typeof alias === 'string') {
        values.push(alias);
        continue;
      }

      if (alias && typeof alias === 'object') {
        const record = alias as Record<string, unknown>;

        const value =
          record.name ??
          record.title ??
          record.value;

        if (typeof value === 'string') {
          values.push(value);
        }
      }
    }

    return this.uniqueTitles(values);
  }

  private extractYear(item: TvdbSeries): number | undefined {
    const rawYear = item.year ??
      item.first_air_time?.slice(0, 4) ??
      item.firstAired?.slice(0, 4);

    if (typeof rawYear === 'number' && Number.isInteger(rawYear)) {
      return rawYear;
    }

    if (typeof rawYear === 'string') {
      const parsed = Number.parseInt(rawYear.slice(0, 4), 10);

      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private buildAirDate(
    aired: string | undefined,
    airsTime: string | undefined,
  ): string | undefined {
    if (!aired) {
      return undefined;
    }

    if (!airsTime) {
      return aired;
    }

    try {
      return new Date(
        `${aired.slice(0, 10)}T${airsTime}:00`,
      ).toISOString();
    } catch {
      return aired;
    }
  }

  private slugToTitle(slug: string | undefined): string | undefined {
    if (!slug?.trim()) {
      return undefined;
    }

    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getString(
    item: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = item[key];

    return typeof value === 'string' ? value : undefined;
  }

  private isEnglishLanguage(language: string | undefined): boolean {
    return language === 'en' ||
      language === 'eng' ||
      language === 'english';
  }

  private uniqueTitles(
    values: Array<string | null | undefined>,
  ): string[] {
    const seen = new Set<string>();

    return values.filter((value): value is string => {
      if (!value?.trim()) {
        return false;
      }

      const normalized = value
        .normalize('NFKC')
        .replace(/[._]+/g, ' ')
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();

      if (!normalized || seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      return true;
    });
  }
}
