import { BaseProvider } from './base';
import type { Show, Episode, IMetadataProvider, EpisodeQuery, Season } from '../core/types';

export class TMDBProvider extends BaseProvider implements IMetadataProvider {
  name = 'tmdb';
  protected apiBaseUrl = 'https://api.themoviedb.org/3';

  /**
   * Movie ids are stored provider-side prefixed (`m-<tmdbid>`) so a film
   * and a series sharing a numeric TMDB id never collide in
   * show_providers — and so getShow() below can route to /movie/ without
   * any caller needing to know the kind.
   */
  static readonly MOVIE_PREFIX = 'm-';

  static isMovieId(id: string): boolean {
    return id.startsWith(TMDBProvider.MOVIE_PREFIX);
  }

  static stripMoviePrefix(id: string): string {
    return TMDBProvider.isMovieId(id) ? id.slice(TMDBProvider.MOVIE_PREFIX.length) : id;
  }

  constructor(config: any = {}) {
    super(config);
    const token = config?.apiKeys?.tmdb || process.env.TMDB_API_KEY || '';
    this.apiKey = token;
    // TMDB ships two credential shapes: v3 API keys (32-hex, ride the
    // `?api_key=` query param) and v4 read-access tokens (JWTs starting
    // `eyJ…`, which MUST ride the `Authorization: Bearer` header — passing
    // a JWT as `?api_key=` always 401s (issues #32). Detect by shape so
    // either paste works.
    this.useBearer = token.startsWith('eyJ');
  }

  private useBearer = false;

  protected override async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (this.useBearer) {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${this.apiKey}`);
      options = { ...options, headers };
    }
    return super.fetch(endpoint, options);
  }

  /** Query string for a TMDB call: v3 keys append `api_key`, Bearer
   *  tokens authenticate via header and need no query param. */
  private qs(params: Record<string, string | undefined>): string {
    const all: Record<string, string> = {};
    if (!this.useBearer && this.apiKey) all.api_key = this.apiKey;
    for (const [k, v] of Object.entries(params)) if (v !== undefined) all[k] = v;
    const s = new URLSearchParams(all).toString();
    return s ? `?${s}` : '';
  }

  override async searchShow(query: string): Promise<Show[]> {
    const data = await this.fetch<{ results: any[] }>(
      `/search/tv${this.qs({ query, language: 'en-US' })}`
    );

    return data.results.map(item => ({
      id: item.id.toString(),
      title: item.name,
      year: item.first_air_date ? parseInt(item.first_air_date.substring(0, 4)) : undefined,
      provider: this.name,
      normalizedId: item.id.toString(),
      metadata: item
    }));
  }

  override async getShow(id: string): Promise<Show> {
    // Library movies are stored with the m- prefix — route straight to
    // /movie/ so every existing getShow() caller (warmer, images, sync,
    // bulk detail) works for films untouched.
    if (TMDBProvider.isMovieId(id)) return this.getMovie(id);
    const data = await this.fetch<any>(`/tv/${id}${this.qs({ language: 'en-US', append_to_response: 'external_ids' })}`);
    return {
      id: data.id.toString(),
      title: data.name,
      year: data.first_air_date ? parseInt(data.first_air_date.substring(0, 4)) : undefined,
      provider: this.name,
      metadata: data,
    };
  }

  override async getSeasons(showId: string): Promise<Season[]> {
    const data = await this.fetch<any>(`/tv/${showId}${this.qs({ language: 'en-US' })}`);
    const seasons = data.seasons || [];

    return seasons.map((s: any) => ({
      id: s.id.toString(),
      number: s.season_number,
      name: s.name,
      metadata: s,
    }));
  }

  override async getEpisodes(showId: string, seasonNumber?: number): Promise<Episode[]> {
    const data = await this.fetch<any>(`/tv/${showId}${this.qs({ language: 'en-US' })}`);
    const seasons = data.seasons || [];

    let allEpisodes: Episode[] = [];
    for (const s of seasons) {
      const seasonData = await this.fetch<any>(`/tv/${showId}/season/${s.season_number}${this.qs({})}`);
      allEpisodes.push(...(seasonData.episodes || []).map((e: any) => ({
        season: s.season_number,
        episode: e.episode_number,
        absoluteNumber: undefined,
        title: e.name,
        // TMDB uses "" for unannounced dates — normalize to undefined so
        // the DB layer stores NULL (unscheduled) instead of "".
        airDate: e.air_date || undefined,
        metadata: e,
      })));
    }

    if (seasonNumber !== undefined) {
      return allEpisodes.filter(e => e.season === seasonNumber);
    }

    return allEpisodes;
  }

  override async getEpisode(showId: string, episodeInfo: EpisodeQuery): Promise<Episode> {
    if (episodeInfo.season != null && episodeInfo.episode != null) {
      return this.getEpisodeBySeasonEpisode(showId, episodeInfo.season, episodeInfo.episode);
    }

    if (episodeInfo.absoluteNumber != null) {
      return this.getEpisodeByAbsolute(showId, episodeInfo.absoluteNumber);
    }

    throw new Error('TMDBProvider.getEpisode requires either {season, episode} or {absoluteNumber}');
  }

  private async getEpisodeBySeasonEpisode(showId: string, season: number, episode: number): Promise<Episode> {
    const data = await this.fetch<any>(
      `/tv/${showId}/season/${season}/episode/${episode}${this.qs({})}`
    );

    return {
      season,
      episode,
      absoluteNumber: undefined,
      title: data.name,
      airDate: data.air_date || undefined,
      metadata: data
    };
  }

  /**
   * TMDB has no native "absolute numbering" concept (unlike TVDB/AniDB).
   * We approximate it by walking seasons in order (skipping specials, season 0)
   * and counting episodes cumulatively until we reach the target absolute index.
   * This matches how most anime/long-running-show release groups count episodes.
   */
  private async getEpisodeByAbsolute(showId: string, absolute: number): Promise<Episode> {
    const show = await this.fetch<any>(`/tv/${showId}${this.qs({})}`);
    const seasons = (show.seasons || [])
      .filter((s: any) => s.season_number > 0)
      .sort((a: any, b: any) => a.season_number - b.season_number);

    let remaining = absolute;

    for (const s of seasons) {
      const seasonData = await this.fetch<any>(
        `/tv/${showId}/season/${s.season_number}${this.qs({})}`
      );
      const episodes = seasonData.episodes || [];

      if (remaining <= episodes.length) {
        const ep = episodes[remaining - 1];
        return {
          season: s.season_number,
          episode: ep.episode_number,
          absoluteNumber: absolute,
          title: ep.name,
          airDate: ep.air_date || undefined,
          metadata: ep
        };
      }

      remaining -= episodes.length;
    }

    throw new Error(
      `TMDBProvider: absolute episode ${absolute} exceeds the known episode count for show ${showId}`
    );
  }

  /**
   * All available backdrop images for a show, best-voted first. Powers the
   * banner cycler: the detail page lets the user pick among these instead
   * of being stuck with whatever single backdrop the metadata carries.
   */
  async getBackdrops(id: string): Promise<{ url: string; width?: number; height?: number }[]> {
    // Movie ids (m- prefix) route to the film image list — same shape.
    const mid = TMDBProvider.stripMoviePrefix(id);
    const path = TMDBProvider.isMovieId(id) ? `/movie/${mid}/images` : `/tv/${id}/images`;
    const data = await this.fetch<any>(`${path}${this.qs({})}`);
    const backdrops = Array.isArray(data?.backdrops) ? data.backdrops : [];
    return backdrops
      .filter((b: any) => typeof b?.file_path === 'string' && b.file_path.length > 0)
      .sort((a: any, b: any) => (b?.vote_average ?? 0) - (a?.vote_average ?? 0))
      .map((b: any) => ({
        url: `https://image.tmdb.org/t/p/w1280${b.file_path}`,
        width: typeof b?.width === 'number' ? b.width : undefined,
        height: typeof b?.height === 'number' ? b.height : undefined,
      }));
  }

  /**
   * Film metadata for a (possibly m- prefixed) movie id. Stored library
   * ids keep the prefix so films never collide with same-numbered series.
   */
  async getMovie(id: string): Promise<Show> {
    const mid = TMDBProvider.stripMoviePrefix(id);
    const data = await this.fetch<any>(`/movie/${mid}${this.qs({ language: 'en-US', append_to_response: 'external_ids' })}`);
    return {
      id: `${TMDBProvider.MOVIE_PREFIX}${data.id}`,
      title: data.title,
      year: data.release_date ? parseInt(data.release_date.substring(0, 4)) : undefined,
      originalTitle: data.original_title,
      provider: this.name,
      metadata: { ...data, media_kind: 'movie' },
    };
  }

  async searchMovies(query: string): Promise<Show[]> {
    const data = await this.fetch<{ results: any[] }>(
      `/search/movie${this.qs({ query, language: 'en-US', include_adult: 'false' })}`
    );
    return data.results.map(item => ({
      id: `${TMDBProvider.MOVIE_PREFIX}${item.id}`,
      title: item.title,
      year: item.release_date ? parseInt(item.release_date.substring(0, 4)) : undefined,
      originalTitle: item.original_title,
      provider: this.name,
      normalizedId: `${TMDBProvider.MOVIE_PREFIX}${item.id}`,
      metadata: { ...item, media_kind: 'movie' },
    }));
  }
}
