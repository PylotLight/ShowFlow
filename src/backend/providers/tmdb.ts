import { BaseProvider } from './base';
import type { Show, Episode, IMetadataProvider, EpisodeQuery, Season } from '../core/types';

export class TMDBProvider extends BaseProvider implements IMetadataProvider {
  name = 'tmdb';
  protected apiBaseUrl = 'https://api.themoviedb.org/3';

  constructor(config: any = {}) {
    super(config);
    this.apiKey = config?.apiKeys?.tmdb || process.env.TMDB_API_KEY || '';
  }

  override async searchShow(query: string): Promise<Show[]> {
    const data = await this.fetch<{ results: any[] }>(
      `/search/tv?api_key=${this.apiKey}&query=${encodeURIComponent(query)}&language=en-US`
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
    const data = await this.fetch<any>(`/tv/${id}?api_key=${this.apiKey}&language=en-US`);
    return {
      id: data.id.toString(),
      title: data.name,
      year: data.first_air_date ? parseInt(data.first_air_date.substring(0, 4)) : undefined,
      provider: this.name,
      metadata: data,
    };
  }

  override async getSeasons(showId: string): Promise<Season[]> {
    const data = await this.fetch<any>(`/tv/${showId}?api_key=${this.apiKey}&language=en-US`);
    const seasons = data.seasons || [];

    return seasons.map((s: any) => ({
      id: s.id.toString(),
      number: s.season_number,
      name: s.name,
      metadata: s,
    }));
  }

  override async getEpisodes(showId: string, seasonNumber?: number): Promise<Episode[]> {
    const data = await this.fetch<any>(`/tv/${showId}?api_key=${this.apiKey}&language=en-US`);
    const seasons = data.seasons || [];

    let allEpisodes: Episode[] = [];
    for (const s of seasons) {
      const seasonData = await this.fetch<any>(`/tv/${showId}/season/${s.season_number}?api_key=${this.apiKey}`);
      allEpisodes.push(...(seasonData.episodes || []).map((e: any) => ({
        season: s.season_number,
        episode: e.episode_number,
        absoluteNumber: undefined,
        title: e.name,
        airDate: e.air_date,
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
      `/tv/${showId}/season/${season}/episode/${episode}?api_key=${this.apiKey}`
    );

    return {
      season,
      episode,
      absoluteNumber: undefined,
      title: data.name,
      airDate: data.air_date,
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
    const show = await this.fetch<any>(`/tv/${showId}?api_key=${this.apiKey}`);
    const seasons = (show.seasons || [])
      .filter((s: any) => s.season_number > 0)
      .sort((a: any, b: any) => a.season_number - b.season_number);

    let remaining = absolute;

    for (const s of seasons) {
      const seasonData = await this.fetch<any>(
        `/tv/${showId}/season/${s.season_number}?api_key=${this.apiKey}`
      );
      const episodes = seasonData.episodes || [];

      if (remaining <= episodes.length) {
        const ep = episodes[remaining - 1];
        return {
          season: s.season_number,
          episode: ep.episode_number,
          absoluteNumber: absolute,
          title: ep.name,
          airDate: ep.air_date,
          metadata: ep
        };
      }

      remaining -= episodes.length;
    }

    throw new Error(
      `TMDBProvider: absolute episode ${absolute} exceeds the known episode count for show ${showId}`
    );
  }
}
