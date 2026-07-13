import { BaseProvider } from './base';
import type { Show, Episode, IMetadataProvider, EpisodeQuery, Season } from '../core/types';
import { db } from '../db';

export class AniListProvider extends BaseProvider implements IMetadataProvider {
  name = 'anilist';
  protected apiBaseUrl = 'https://graphql.anilist.co';
  override apiKey = ''; // AniList GraphQL doesn't require a key for public search

  protected override async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    // AniList uses GraphQL: the query lives in the body, endpoint is always
    // the base URL. Cache on the request body since that's what varies.
    const key = `${this.name}:${options.body ?? ''}`;
    const cached = db.getCache<T>(key);
    if (cached !== null) return cached;

    const response = await fetch(this.apiBaseUrl, {
      ...options,
      method: 'POST',
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.fetch(endpoint, options);
    }

    if (!response.ok) {
      throw new Error(`AniList Request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { data: T };
    db.setCache(key, result.data);
    return result.data;
  }

  override async searchShow(query: string): Promise<Show[]> {
    const gqlQuery = {
      query: `
        query ($search: String) {
          Page(perPage: 10) {
            media (search: $search, type: ANIME) {
              id
              title { romaji english native }
              startDate { year }
            }
          }
        }
      `,
      variables: { search: query },
    };

    const data = await this.fetch<{ Page: { media: any[] } }>(this.apiBaseUrl, {
      body: JSON.stringify(gqlQuery),
    });

    const mediaList = data.Page?.media ?? [];
    return mediaList.map((media) => ({
      id: media.id.toString(),
      title: media.title.english || media.title.romaji,
      originalTitle: media.title.native,
      romanizedTitle: media.title.romaji,
      year: media.startDate?.year,
      provider: this.name,
      normalizedId: media.id.toString(),
      metadata: media
    }));
  }

  /**
   * AniList doesn't model individual TV "episodes" the way TMDB/TVDB do -
   * anime is almost always numbered absolutely with no season split. We use
   * AniList's AiringSchedule query (mediaId + episode number) to get the air
   * date; episode titles generally don't exist in AniList's schema, so we
   * fall back to a generic "Episode N" label.
   */
  override async getEpisode(showId: string, episodeInfo: EpisodeQuery): Promise<Episode> {
    const epNum = episodeInfo.absoluteNumber ?? episodeInfo.episode;
    if (epNum == null) {
      throw new Error('AniListProvider.getEpisode requires either {episode} or {absoluteNumber}');
    }

    const gqlQuery = {
      query: `
        query ($mediaId: Int, $episode: Int) {
          AiringSchedule (mediaId: $mediaId, episode: $episode) {
            episode
            airingAt
          }
        }
      `,
      variables: { mediaId: parseInt(showId, 10), episode: epNum },
    };

    let airDate: string | undefined;
    try {
      const data = await this.fetch<{ AiringSchedule: { airingAt: number } | null }>(this.apiBaseUrl, {
        body: JSON.stringify(gqlQuery),
      });
      if (data.AiringSchedule?.airingAt) {
        airDate = new Date(data.AiringSchedule.airingAt * 1000).toISOString();
      }
    } catch {
      // Airing schedule may not exist yet for unaired/very old episodes -
      // proceed without an air date rather than failing the whole resolve.
    }

    return {
      season: 1, // AniList doesn't use seasons the way TVDB/TMDB do
      episode: epNum,
      absoluteNumber: epNum,
      title: `Episode ${epNum}`,
      airDate,
      metadata: { mediaId: showId, episode: epNum }
    };
  }

  override async getSeasons(showId: string): Promise<Season[]> {
    return [{
      id: '1',
      number: 1,
      name: 'Season 1',
      metadata: { showId }
    }];
  }

  override async getEpisodes(showId: string, seasonNumber?: number): Promise<Episode[]> {
    const scheduleMap = new Map<number, number>();
    let page = 1;

    try {
      while (true) {
        const gqlQuery = {
          query: `
            query ($mediaId: Int, $page: Int) {
              Media(id: $mediaId, type: ANIME) {
                id
                episodes
                airingSchedule(notYetAired: false, perPage: 50, page: $page) {
                  nodes {
                    episode
                    airingAt
                  }
                  pageInfo {
                    hasNextPage
                  }
                }
              }
            }
          `,
          variables: { mediaId: parseInt(showId, 10), page },
        };

        const data = await this.fetch<{ Media: { episodes: number | null; airingSchedule: { nodes: { episode: number; airingAt: number }[]; pageInfo: { hasNextPage: boolean } } | null } }>(this.apiBaseUrl, {
          body: JSON.stringify(gqlQuery),
        });

        const media = data?.Media;
        if (!media) break;

        if (media.airingSchedule?.nodes) {
          for (const node of media.airingSchedule.nodes) {
            scheduleMap.set(node.episode, node.airingAt);
          }
        }

        const hasNext = media.airingSchedule?.pageInfo?.hasNextPage ?? false;
        if (!hasNext || page > 100) break;
        page++;
      }

      const totalEpisodes = scheduleMap.size;
      if (totalEpisodes === 0) return [];

      const episodes: Episode[] = [];
      for (let i = 1; i <= totalEpisodes; i++) {
        const airingAt = scheduleMap.get(i);
        episodes.push({
          season: 1,
          episode: i,
          absoluteNumber: i,
          title: `Episode ${i}`,
          airDate: airingAt ? new Date(airingAt * 1000).toISOString() : undefined,
          metadata: { mediaId: showId, episode: i },
        });
      }

      return episodes;
    } catch {
      return [];
    }
  }

  override async getShow(id: string): Promise<Show> {
    const gqlQuery = {
      query: `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english native } bannerImage coverImage { large medium } episodes } }`,
      variables: { id: parseInt(id, 10) },
    };

    const data = await this.fetch<{ Media: any }> (this.apiBaseUrl, {
      method: 'POST',
      body: JSON.stringify(gqlQuery),
    });

    const media = data?.Media;
    if (!media) throw new Error(`AniListProvider: show not found for ID ${id}`);
    return {
      id: media.id.toString(),
      title: media.title.english || media.title.romaji,
      originalTitle: media.title.native,
      romanizedTitle: media.title.romaji,
      provider: this.name,
      metadata: media,
    };
  }
}
