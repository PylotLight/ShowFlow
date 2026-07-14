import { db } from '../../db';
import { debugLog } from '../../core/debug';
import { JellyfinClient, type JellyfinItem, type JellyfinProviderIds } from './client';

export interface JellyfinSyncResult {
  totalEpisodes: number;
  matchedEpisodes: number;
  trackedEpisodes: number;
  errors: string[];
}

export class JellyfinSync {
  private client: JellyfinClient;

  constructor(baseUrl: string, apiKey: string) {
    this.client = new JellyfinClient(baseUrl, apiKey);
  }

  async sync(): Promise<JellyfinSyncResult> {
    const result: JellyfinSyncResult = {
      totalEpisodes: 0,
      matchedEpisodes: 0,
      trackedEpisodes: 0,
      errors: [],
    };

    let users;
    try {
      users = await this.client.getUsers();
    } catch (err) {
      result.errors.push(`Failed to fetch users: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    for (const user of users) {
      let watchedEpisodes: JellyfinItem[];
      try {
        watchedEpisodes = await this.client.getWatchedEpisodes(user.Id);
      } catch (err) {
        result.errors.push(`Failed to fetch watched episodes for user ${user.Name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      result.totalEpisodes += watchedEpisodes.length;

      // Collect unique SeriesIds from watched episodes
      const seriesIds = [...new Set(watchedEpisodes.map(e => e.SeriesId).filter(Boolean))];

      // Fetch series-level provider IDs in batch
      const seriesProviderMap = await this.client.getSeriesBatch(seriesIds, user.Id);

      for (const item of watchedEpisodes) {
        try {
          const matched = this.matchAndTrack(item, seriesProviderMap);
          if (matched) {
            result.matchedEpisodes++;
            result.trackedEpisodes++;
          }
        } catch (err) {
          result.errors.push(`Error processing ${item.SeriesName || 'unknown'} S${item.ParentIndexNumber}E${item.IndexNumber}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    debugLog(`Jellyfin sync complete: ${result.totalEpisodes} watched episodes, ${result.matchedEpisodes} matched, ${result.errors.length} errors`);

    return result;
  }

  private matchAndTrack(item: JellyfinItem, seriesProviderMap: Map<string, JellyfinProviderIds>): boolean {
    const seasonNumber = item.ParentIndexNumber ?? 0;
    const episodeNumber = item.IndexNumber ?? 0;

    if (seasonNumber <= 0 || episodeNumber <= 0) return false;

    // Get series-level provider IDs (these have the correct show-level TVDB/TMDB IDs)
    const seriesIds = seriesProviderMap.get(item.SeriesId);
    if (!seriesIds) return false;

    // Try to match by TVDB ID first
    if (seriesIds.Tvdb) {
      const show = db.getShowByProvider('tvdb', seriesIds.Tvdb);
      if (show) {
        db.setTracked(show.uuid, seasonNumber, episodeNumber, true);
        return true;
      }
    }

    // Fall back to TMDB ID
    if (seriesIds.Tmdb) {
      const show = db.getShowByProvider('tmdb', seriesIds.Tmdb);
      if (show) {
        db.setTracked(show.uuid, seasonNumber, episodeNumber, true);
        return true;
      }
    }

    return false;
  }
}
