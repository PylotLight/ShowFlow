import { db } from '../../db';
import { ProviderFactory } from '../factory';
import type { Config } from '../../db';
import { SonarrClient, type SonarrSeries, type SonarrEpisode } from './client';
import { SyncManager } from '../../core/sync_manager';
import { backgroundJobs } from '../../core/background_jobs';
import { probeMediaFile } from '../../core/media_probe';

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
  /** ShowFlow library_types.id — resolves to root folder + quality profile in one lookup. Takes priority over showProfileId/qualityProfileId when set. */
  libraryTypeId?: string;
  /** ShowFlow show_profiles.id — resolved to a root folder path. Only used when libraryTypeId is not set. */
  showProfileId?: string;
  /** ShowFlow quality_profiles.id (e.g. 'standard' | 'anime'). Only used when libraryTypeId is not set. */
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

  /**
   * @param jobId Optional Background Activity registry id
   * (core/background_jobs.ts). When provided, this method updates that
   * job's progress after every series - both the wizard's own progress
   * view and the global header popover read from this same job rather
   * than each maintaining separate state (design-brief-platform-ux-systems.md §2).
   * The caller (routes/integrations.ts) is responsible for calling
   * backgroundJobs.register() before invoking this and complete()/fail()
   * are called here once the loop finishes.
   */
  async importSeries(seriesIds?: number[], typeMapping?: SonarrTypeMapping, jobId?: string): Promise<ImportResult[]> {
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

    if (jobId) {
      backgroundJobs.update(jobId, { total: toImport.length, completed: 0, detail: `0/${toImport.length} series` });
    }

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
      } finally {
        if (jobId) {
          const imported = results.filter(r => r.status === 'imported').length;
          const existing = results.filter(r => r.status === 'existing').length;
          const errored = results.filter(r => r.status === 'error').length;
          backgroundJobs.update(jobId, {
            completed: results.length,
            detail: `${results.length}/${toImport.length} processed - ${imported} imported, ${existing} existing, ${errored} errored`,
          });
        }
      }
    }

    const imported = results.filter(r => r.status === 'imported').length;
    const existing = results.filter(r => r.status === 'existing').length;
    const errored = results.filter(r => r.status === 'error').length;

    db.logEvent({
      type: 'import',
      entityType: 'system',
      entityId: 'sonarr-import',
      message: `Sonarr import complete: ${imported} imported, ${existing} existing, ${errored} errors`,
    });

    if (jobId) {
      backgroundJobs.complete(jobId, `${imported} imported, ${existing} existing, ${errored} errored`);
    }

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

    // Fetch provider metadata — try primary provider, then fallback,
    // then continue with Sonarr data if neither is available
    let showData: any = null;
    let resolvedProviderType = providerType;
    let resolvedProviderId = providerId;

    const providerCandidates = [
      { type: providerType, id: providerId },
      // Try the other provider as fallback
      ...(tvdbId && tmdbId ? [{ type: providerType === 'tvdb' ? 'tmdb' as const : 'tvdb' as const, id: providerType === 'tvdb' ? tmdbId : tvdbId }] : []),
    ];

    for (const candidate of providerCandidates) {
      try {
        const provider = ProviderFactory.getProvider(candidate.type as any, this.config);
        showData = await provider.getShow(candidate.id);
        resolvedProviderType = candidate.type;
        resolvedProviderId = candidate.id;
        break;
      } catch (err) {
        console.warn(`[sonarr] ${candidate.type} metadata fetch failed for "${series.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
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
    //
    // When libraryTypeId is set, it resolves to both root folder and quality
    // profile in one lookup (design-brief-platform-ux-systems.md §1).
    let rootFolderPath: string | undefined;
    let qualityProfileId: string | undefined;
    let mappedLibraryTypeId: string | undefined;

    if (mapping?.libraryTypeId) {
      mappedLibraryTypeId = db.resolveLibraryTypeId(mapping.libraryTypeId);
      const libraryType = mappedLibraryTypeId ? db.getLibraryType(mappedLibraryTypeId) : null;
      if (libraryType) {
        rootFolderPath = libraryType.root_folder_path ?? undefined;
        qualityProfileId = libraryType.quality_profile_id ?? undefined;
      }
    }

    if (!rootFolderPath && mapping?.showProfileId) {
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

    if (!qualityProfileId) {
      qualityProfileId = mapping?.qualityProfileId;
    }

    db.saveShow({
      uuid: showUuid,
      providerId: resolvedProviderId,
      type: resolvedProviderType,
      title: series.title,
      originalTitle: showData?.originalTitle,
      romanizedTitle: showData?.romanizedTitle,
      metadata: showData?.metadata,
      year: showData?.year,
      rootFolderPath: rootFolderPath ?? undefined,
      profile: qualityProfileId,
      seriesType,
      libraryTypeId: mappedLibraryTypeId,
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
          airDate: ep.airDateUtc ?? ep.airDate ?? undefined,
        });

        // Record on-disk provenance when Sonarr already has the file stored.
        // Sonarr's sceneName is the original release title; prefer it for the
        // release display, and stash the file size + date added alongside.
        if (ep.episodeFile?.path) {
          try {
            // Probe the on-disk file so the provenance row carries its real
            // resolution/codec/bitrate (media badges + upgrade compare). Probe
            // failure is non-fatal: we still record provenance, just without
            // the media columns.
            const probe = await probeMediaFile(ep.episodeFile.path);
            db.recordEpisodeFile({
              showId: showUuid,
              season: ep.seasonNumber,
              episode: ep.episodeNumber,
              filePath: ep.episodeFile.path,
              originalName: ep.episodeFile.path.split(/[\\/]/).pop() ?? ep.episodeFile.path,
              fileSize: ep.episodeFile.size ?? null,
              sourceKind: ep.episodeFile.sceneName ? 'release' : 'import',
              releaseTitle: ep.episodeFile.sceneName ?? null,
              indexerName: null,
              publishDate: ep.episodeFile.dateAdded ?? null,
              media: probe
                ? {
                    container: probe.container,
                    video_width: probe.video?.width ?? null,
                    video_height: probe.video?.height ?? null,
                    video_codec: probe.video?.codec?.toLowerCase() ?? null,
                    video_fps: probe.video?.fps ? Math.round(probe.video.fps) : null,
                    hdr: probe.video?.hdr ? 1 : null,
                    audio_codec: probe.audio?.[0]?.codec?.toLowerCase() ?? null,
                    audio_channels: probe.audio?.[0]?.channels ?? null,
                    duration_seconds: probe.durationSeconds ? Math.round(probe.durationSeconds) : null,
                    bitrate_kbps: probe.overallBitrate ? Math.round(probe.overallBitrate / 1000) : null,
                  }
                : null,
            });
          } catch (err) {
            console.warn(`[sonarr-import] Failed to record provenance for ${showUuid} S${ep.seasonNumber}E${ep.episodeNumber}:`, err);
          }
        }

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
