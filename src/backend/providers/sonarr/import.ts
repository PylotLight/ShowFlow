import { db } from '../../db';
import { ProviderFactory } from '../factory';
import type { Config } from '../../db';
import { SonarrClient, type SonarrSeries, type SonarrEpisode } from './client';

export interface ImportResult {
  seriesId: string;
  sonarrSeriesId: number;
  title: string;
  status: 'imported' | 'skipped' | 'existing' | 'error';
  message?: string;
}

export class SonarrImporter {
  private client: SonarrClient;
  private config: Config;

  constructor(baseUrl: string, apiKey: string, apiVersion: 'v3' | 'v5', config: Config) {
    this.client = new SonarrClient(baseUrl, apiKey, apiVersion);
    this.config = config;
  }

  async listSeries(): Promise<SonarrSeries[]> {
    return this.client.getSeries();
  }

  async importSeries(seriesIds?: number[]): Promise<ImportResult[]> {
    const allSeries = await this.client.getSeries();
    const toImport = seriesIds
      ? allSeries.filter(s => seriesIds.includes(s.id))
      : allSeries;

    const results: ImportResult[] = [];

    for (const series of toImport) {
      try {
        const result = await this.importSingleSeries(series);
        results.push(result);
      } catch (err) {
        results.push({
          seriesId: '',
          sonarrSeriesId: series.id,
          title: series.title,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  private async importSingleSeries(series: SonarrSeries): Promise<ImportResult> {
    // Determine the best provider type from Sonarr's IDs
    const tvdbId = series.tvdbId ? String(series.tvdbId) : null;
    const tmdbId = series.tmdbId ? String(series.tmdbId) : null;

    // Check if show already exists by any provider ID
    if (tvdbId) {
      const existing = db.getShowByProvider('tvdb', tvdbId);
      if (existing) {
        return {
          seriesId: existing.id,
          sonarrSeriesId: series.id,
          title: series.title,
          status: 'existing',
          message: 'Show already in library via TVDB',
        };
      }
    }
    if (tmdbId) {
      const existing = db.getShowByProvider('tmdb', tmdbId);
      if (existing) {
        return {
          seriesId: existing.id,
          sonarrSeriesId: series.id,
          title: series.title,
          status: 'existing',
          message: 'Show already in library via TMDB',
        };
      }
    }

    // Try TVDB first, fall back to TMDB
    const providerType = tvdbId ? 'tvdb' : tmdbId ? 'tmdb' : null;
    if (!providerType) {
      return {
        seriesId: '',
        sonarrSeriesId: series.id,
        title: series.title,
        status: 'error',
        message: 'Sonarr series has no TVDB or TMDB ID',
      };
    }

    const providerId = providerType === 'tvdb' ? tvdbId! : tmdbId!;

    // Fetch provider metadata
    const provider = ProviderFactory.getProvider(providerType as any, this.config);

    let showData: any;
    try {
      showData = await provider.getShow(providerId);
    } catch (err) {
      return {
        seriesId: '',
        sonarrSeriesId: series.id,
        title: series.title,
        status: 'error',
        message: `Failed to fetch metadata from ${providerType}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Create show in database
    const showUuid = crypto.randomUUID();

    const showProfiles = db.listShowProfiles();
    const profileId = showProfiles.length > 0 ? showProfiles[0]!.id : null;
    const rootFolderPath: string | undefined = series.rootFolderPath || (profileId ? db.getShowProfileRootFolder(profileId) ?? undefined : undefined);

    const seriesType = series.seriesType === 'anime' ? 'anime' : series.seriesType === 'daily' ? 'daily' : 'standard';

    db.saveShow({
      uuid: showUuid,
      providerId,
      type: providerType,
      title: series.title,
      originalTitle: showData.originalTitle,
      romanizedTitle: showData.romanizedTitle,
      metadata: showData.metadata,
      rootFolderPath: rootFolderPath ?? undefined,
      seriesType,
      config: {},
    });

    // Sync episodes from Sonarr
    let sonarrEpisodes: SonarrEpisode[];
    try {
      sonarrEpisodes = await this.client.getEpisodes(series.id);
    } catch (err) {
      return {
        seriesId: showUuid,
        sonarrSeriesId: series.id,
        title: series.title,
        status: 'imported',
        message: 'Show created but failed to import episodes',
      };
    }

    // Group episodes by season for processing
    const seasonMap = new Map<number, SonarrEpisode[]>();
    for (const ep of sonarrEpisodes) {
      const season = ep.seasonNumber;
      if (!seasonMap.has(season)) seasonMap.set(season, []);
      seasonMap.get(season)!.push(ep);
    }

    for (const [seasonNumber, episodes] of seasonMap) {
      db.saveSeason(showUuid, seasonNumber);

      for (const ep of episodes) {
        db.saveEpisode({
          showId: showUuid,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          absoluteNumber: ep.absoluteEpisodeNumber ?? undefined,
          title: ep.title ?? undefined,
          filePath: ep.episodeFile?.path ?? undefined,
        });

        // Set tracked state from Sonarr's monitored flag
        if (ep.monitored) {
          db.setTracked(showUuid, ep.seasonNumber, ep.episodeNumber, true);
        }
      }
    }

    // Log import event
    db.logEvent({
      type: 'import',
      entityType: 'show',
      entityId: showUuid,
      message: `Imported from Sonarr: "${series.title}" (${sonarrEpisodes.length} episodes)`,
    });

    return {
      seriesId: showUuid,
      sonarrSeriesId: series.id,
      title: series.title,
      status: 'imported',
      message: `Imported ${sonarrEpisodes.length} episodes`,
    };
  }
}
