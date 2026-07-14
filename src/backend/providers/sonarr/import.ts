import { db } from '../../db';
import { ProviderFactory } from '../factory';
import type { Config } from '../../db';
import { SonarrClient, type SonarrSeries, type SonarrEpisode } from './client';
import { SyncManager } from '../../core/sync_manager';

export interface ImportResult {
  seriesId: string;
  sonarrSeriesId: number;
  title: string;
  status: 'imported' | 'skipped' | 'existing' | 'error';
  message?: string;
}

/** Sonarr's `seriesType` values — used as the key for per-type mapping. */
export type SonarrSeriesType = 'standard' | 'daily' | 'anime';

/**
 * Per-type destination mapping chosen in the import UI. When a mapping is
 * present for a series' seriesType, it takes priority over both Sonarr's own
 * rootFolderPath and the "just grab the first profile" fallback — the whole
 * point of a mapped import is that the person is explicitly choosing where
 * each type of show should land in ShowFlow, not inheriting Sonarr's layout.
 */
export type SonarrTypeMapping = Partial<Record<SonarrSeriesType, {
  /** ShowFlow show_profiles.id — resolved to a root folder path. */
  showProfileId?: string;
  /** ShowFlow quality_profiles.id (e.g. 'standard' | 'anime'). */
  qualityProfileId?: string;
}>>;

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

  async importSeries(seriesIds?: number[], typeMapping?: SonarrTypeMapping): Promise<ImportResult[]> {
    const allSeries = await this.client.getSeries();
    const toImport = seriesIds
      ? allSeries.filter(s => seriesIds.includes(s.id))
      : allSeries;

    const results: ImportResult[] = [];

    db.logEvent({
      type: 'import',
      entityType: 'system',
      entityId: 'sonarr-import',
      message: `Starting Sonarr import for ${toImport.length} series`,
    });

    for (const series of toImport) {
      try {
        const result = await this.importSingleSeries(series, typeMapping);
        results.push(result);
        
        // Log progress event
        db.logEvent({
          type: 'import',
          entityType: 'show',
          entityId: result.seriesId,
          message: `Imported "${series.title}" from Sonarr (${results.length}/${toImport.length})`,
        });
      } catch (err) {
        results.push({
          seriesId: '',
          sonarrSeriesId: series.id,
          title: series.title,
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        
        db.logEvent({
          type: 'error',
          entityType: 'show',
          entityId: '',
          message: `Failed to import "${series.title}" from Sonarr: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    db.logEvent({
      type: 'import',
      entityType: 'system',
      entityId: 'sonarr-import',
      message: `Sonarr import complete: ${results.filter(r => r.status === 'imported').length} imported, ${results.filter(r => r.status === 'existing').length} existing, ${results.filter(r => r.status === 'error').length} errors`,
    });

    return results;
  }

  private async importSingleSeries(series: SonarrSeries, typeMapping?: SonarrTypeMapping): Promise<ImportResult> {
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

    const seriesType: SonarrSeriesType = series.seriesType === 'anime' ? 'anime' : series.seriesType === 'daily' ? 'daily' : 'standard';
    const mapping = typeMapping?.[seriesType];

    // A mapping chosen for this series' type wins outright for both the root
    // folder and quality profile - that's the entire point of a mapped
    // import: the person is explicitly choosing where each type lands in
    // ShowFlow rather than inheriting Sonarr's own layout. Without a mapping
    // for this type, fall back to Sonarr's own rootFolderPath (or the first
    // configured show profile) and let saveShow() pick a default quality
    // profile, matching the previous flat-import behavior.
    let rootFolderPath: string | undefined;
    if (mapping?.showProfileId) {
      rootFolderPath = db.getShowProfileRootFolder(mapping.showProfileId) ?? undefined;
    }
    if (!rootFolderPath) {
      if (series.rootFolderPath) {
        rootFolderPath = series.rootFolderPath;
      } else {
        const showProfiles = db.listShowProfiles();
        const fallbackProfileId = showProfiles.length > 0 ? showProfiles[0]!.id : null;
        rootFolderPath = fallbackProfileId ? db.getShowProfileRootFolder(fallbackProfileId) ?? undefined : undefined;
      }
    }

    const qualityProfileId = mapping?.qualityProfileId;

    db.saveShow({
      uuid: showUuid,
      providerId,
      type: providerType,
      title: series.title,
      originalTitle: showData.originalTitle,
      romanizedTitle: showData.romanizedTitle,
      metadata: showData.metadata,
      rootFolderPath: rootFolderPath ?? undefined,
      profile: qualityProfileId,
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

    // Trigger full metadata sync after import to fetch all metadata
    try {
      const syncManager = new SyncManager(this.config);
      await syncManager.syncShow(showUuid);
    } catch (syncErr) {
      console.warn(`[sonarr] Metadata sync failed for "${series.title}":`, syncErr);
      // Don't fail the import if sync fails, just log it
    }

    return {
      seriesId: showUuid,
      sonarrSeriesId: series.id,
      title: series.title,
      status: 'imported',
      message: `Imported ${sonarrEpisodes.length} episodes`,
    };
  }
}
