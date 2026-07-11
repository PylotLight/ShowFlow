import { FilenameParser } from './index';
import { ProviderFactory, type ProviderType } from '../providers/factory';
import { db } from '../db';
import type { Show, Episode, EpisodeQuery } from '../core/types';
import Fuse from 'fuse.js';
import { debugLog } from '../core/debug';

export class Oracle {
  private parser = new FilenameParser();

  async resolve(filename: string, preferredProvider: ProviderType = 'tmdb', config: any = {}): Promise<{
    show: Show;
    episodes: Episode[];
    proposedPath: string;
    } | null> {
    const parsed = this.parser.parse(filename);
    if (!parsed) return null;
    debugLog('Filename parsed', { filename, parsed });

    let providerType = preferredProvider;

    // If the show is already registered in our DB, use that provider instead of the default
    if (parsed.show) {
      const registeredShows = db.getShowByName(parsed.show);
      if (registeredShows.length > 0) {
        providerType = registeredShows[0].provider_type;
      }
    }

    const provider = ProviderFactory.getProvider(providerType, config);
    debugLog('Using provider', { providerType, parsedShow: parsed.show });
    const searchResults = await provider.searchShow(parsed.show!);

    if (searchResults.length === 0) return null;

    // Fuzzy match search results to parsed show name
    const fuse = new Fuse(searchResults, { keys: ['title'], threshold: 0.4 });
    const bestMatch = fuse.search(parsed.show!).at(0);

    if (!bestMatch) return null;
    const show = bestMatch.item;

    // Resolve all episodes in the range
    const episodes: Episode[] = [];
    
    if (parsed.episodes) {
      for (const epNum of parsed.episodes) {
        try {
          const ep = await provider.getEpisode(show.id, { season: parsed.season, episode: epNum });
          episodes.push(ep);
        } catch (e) {
          debugLog('Failed to resolve episode', { showId: show.id, epNum, error: e });
        }
      }
    } else if (parsed.absoluteNumbers) {
      for (const absNum of parsed.absoluteNumbers) {
        try {
          const ep = await provider.getEpisode(show.id, { absoluteNumber: absNum });
          episodes.push(ep);
        } catch (e) {
          debugLog('Failed to resolve absolute episode', { showId: show.id, absNum, error: e });
        }
      }
    }

    if (episodes.length === 0) return null;

    const proposedPath = this.buildPath(show, episodes, filename);

    return { show, episodes, proposedPath };
  }

  /**
   * Builds a Sonarr-style path: `{Show}/Season {SS}/{Show} - S{SS}E{EE} - {Title}.ext`
   * If multiple episodes, uses range: S01E01-03
   */
  private buildPath(show: Show, episodes: Episode[], originalFilename: string): string {
    const extMatch = originalFilename.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0] : '.mkv';

    const firstEp = episodes[0];
    if (!firstEp) return `Unknown/${originalFilename}`;
    const seasonNum = firstEp.season;
    const season = String(seasonNum).padStart(2, '0');
    
    let episodeCode = '';
    if (episodes.length === 1) {
      episodeCode = `S${season}E${String(firstEp.episode).padStart(2, '0')}`;
    } else {
      const lastEp = episodes[episodes.length - 1];
      const firstEpNum = String(firstEp.episode).padStart(2, '0');
      const lastEpNum = lastEp ? String(lastEp.episode).padStart(2, '0') : firstEpNum;
      episodeCode = `S${season}E${firstEpNum}-${lastEpNum}`;
    }
    
    const titleSuffix = firstEp.title ? ` - ${firstEp.title}` : '';

    const safeShowTitle = this.sanitize(show.title);
    const safeTitleSuffix = this.sanitize(titleSuffix);

    const seasonFolder = `Season ${season}`;
    const fileName = `${safeShowTitle} - ${episodeCode}${safeTitleSuffix}${ext}`;

    return `${safeShowTitle}/${seasonFolder}/${fileName}`;
  }

  /** Strips characters that are unsafe/problematic in file and folder names. */
  private sanitize(input: string): string {
    return input.replace(/[<>:"/\\|?*]/g, '').trim();
  }
}
