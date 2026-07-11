import { db, type Config } from '../db';
import { ProviderFactory, type ProviderType } from '../providers/factory';

export interface UpcomingEpisode {
  showTitle: string;
  episodeTitle: string;
  season: number;
  episode: number;
  airDate: Date;
}

export class CalendarManager {
  constructor(private config: Config) {}

  async getUpcomingEpisodes(days: number = 7): Promise<UpcomingEpisode[]> {
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(now.getDate() + days);

    const shows = db.listShows();
    const upcoming: UpcomingEpisode[] = [];

    for (const show of shows) {
      const provider = ProviderFactory.getProvider(show.provider_type as ProviderType, this.config);
      try {
        // Fetch all episodes for the show to find upcoming air dates
        const episodes = await provider.getEpisodes(show.provider_id);
        
        for (const ep of episodes) {
          if (!ep.airDate) continue;
          
          const airDate = new Date(ep.airDate);
          if (airDate >= now && airDate <= endDate) {
            upcoming.push({
              showTitle: show.title,
              episodeTitle: ep.title || `Episode ${ep.episode}`,
              season: ep.season,
              episode: ep.episode,
              airDate,
            });
          }
        }
      } catch (e) {
        console.error(`Error fetching schedule for ${show.title}:`, e);
      }
    }

    return upcoming.sort((a, b) => a.airDate.getTime() - b.airDate.getTime());
  }
}
