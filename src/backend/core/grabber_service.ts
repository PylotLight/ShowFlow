import { db, type Config, ProwlarrConfigSchema } from '../db';
import path from 'node:path';
import { IndexerFactory } from '../providers/indexers/factory';
import type { Indexer, IndexerResult } from '../providers/indexers/types';
import type { NativeIndexerConfig } from '../providers/indexers/native/types';
import { NATIVE_INDEXER_META } from '../providers/indexers/native/types';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { debugLog, logDebug } from './debug';
import { TorboxDownloadClient, resolveTorboxConfig } from './download_clients';

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'it', 'its']);

// TV shows live under Prowlarr's "5000" parent category (5010 SD, 5030 HD,
// 5040 UHD, etc. all roll up under it), so scoping searches to it keeps
// movie-only indexers/junk results out without needing per-indexer category
// mapping.
const TV_CATEGORY = 5000;

export interface ScoredRelease extends IndexerResult {
  score: ReleaseScore;
  /** The indexer instance that produced this result - needed to grab it. */
  indexer: Indexer;
}

export interface GrabResult {
  success: boolean;
  message: string;
  /** The release that was found but NOT grabbed (not an upgrade, or the grab call itself failed). */
  bestRelease?: ScoredRelease;
  /** The release that WAS successfully grabbed. */
  release?: ScoredRelease;
}

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

function isRelevantMatch(title: string, showTitle: string, season: number, episode?: number): boolean {
  const lower = title.toLowerCase();
  const norm = lower.replace(/[._\s-]+/g, ' ');
  const showNorm = showTitle.toLowerCase().replace(/[._\s-]+/g, ' ');

  // Extract significant words from the show title (no stopwords, no single chars)
  const showWords = showNorm.split(/\s+/).filter(w => !STOPWORDS.has(w) && w.length > 1);
  if (showWords.length === 0) return false;

  // Check how many significant show-title words appear in the release title
  const wordMatches = showWords.filter(w => norm.includes(w)).length;
  const enoughTitleWords = wordMatches >= Math.max(1, Math.ceil(showWords.length * 0.75));

  // Check for a season/episode identifier using zero-padded flexible regex
  // Handles S01E01, S1E1, S01E1, S1E01, S01E01-08 (packs), S01 E01, etc.
  if (episode != null) {
    const hasEp = new RegExp(`s0*${season}e0*${episode}(?:[^a-z0-9]|$)`, 'i').test(norm);
    return hasEp && enoughTitleWords;
  }

  // For season-wide searches, just the title words are enough
  return enoughTitleWords;
}

export class GrabberService {
  constructor(private config: Config) {}

  /**
   * Searches all configured indexers for a show's episode - or, if
   * `episode` is omitted, the whole season (season-pack hunting) - and
   * scores every result against the show's assigned quality profile.
   *
   * Shared by the automatic grabber, the season grabber, and the
   * interactive search API so all three agree on what a release is worth.
   */
  private isAnime(providerType: string): boolean {
    return providerType === 'anilist';
  }

  private getSeriesType(show: any): string {
    return show?.series_type ?? (this.isAnime(show?.provider_type) ? 'anime' : 'standard');
  }

  async searchReleases(
    showId: string,
    season: number,
    episode?: number
  ): Promise<{ releases: ScoredRelease[]; profileId: string } | { error: string }> {
    const show = db.getShow(showId);
    if (!show) return { error: `Show ${showId} not found` };

    const libraryType = show.library_type_id ? db.getLibraryType(show.library_type_id) : null;
    const profileId = libraryType?.quality_profile_id ?? db.resolveProfileId(show.profile) ?? '';
    const seriesType = this.getSeriesType(show);
    const anime = seriesType === 'anime' || seriesType === 'absolute';
    const indexers = this.getEnabledIndexers({ libraryType });
    if (indexers.length === 0) {
      const message = 'No indexers configured. Add a Prowlarr or Native indexer in Settings > Indexers.';
      db.logPipelineEvent({
        showId, seasonNumber: season, episodeNumber: episode ?? null,
        stage: 'FAILED', eventType: 'search_no_indexers', reasonCode: 'NO_INDEXERS_CONFIGURED', message,
      });
      return { error: message };
    }

    const query =
      episode != null
        ? seriesType === 'absolute'
          ? `${show.title} ${String(episode).padStart(3, '0')}`
          : `${show.title} S${pad(season)}E${pad(episode)}`
        : `${show.title} S${pad(season)}`;

    const label = episode != null
      ? `S${pad(season)}E${pad(episode)}`
      : `S${pad(season)}`;

    logDebug({
      type: 'grabber',
      level: 'info',
      source: 'GrabberService',
      message: `Searching ${indexers.length} indexers for "${show.title} ${label}" (query: "${query}")`,
    });

    const category = anime ? 5070 : TV_CATEGORY;
    const allReleases: (IndexerResult & { indexer: Indexer })[] = [];
    for (const indexer of indexers) {
      try {
        const results = await indexer.search(query, { type: 'tvsearch', categories: [category] });
        logDebug({
          type: 'grabber',
          level: results.length > 0 ? 'info' : 'debug',
          source: indexer.name,
          message: `Found ${results.length} releases for "${query}"`,
        });
        allReleases.push(...results.map(r => ({ ...r, indexer })));
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logDebug({
          type: 'grabber',
          level: 'error',
          source: indexer.name,
          message: `Search error for "${query}"`,
          error: errorMessage,
        });
        db.logPipelineEvent({
          showId, seasonNumber: season, episodeNumber: episode ?? null,
          stage: 'SEARCHING', eventType: 'indexer_error', reasonCode: 'INDEXER_SEARCH_ERROR',
          message: `${indexer.name} search failed: ${errorMessage}`,
          indexerName: indexer.name,
        });
      }
    }

    const beforeFilter = allReleases.length;
    const filtered = allReleases.filter(r => isRelevantMatch(r.title, show.title, season, episode));
    const removed = beforeFilter - filtered.length;
    if (removed > 0) {
      logDebug({
        type: 'grabber',
        level: 'info',
        source: 'GrabberService',
        message: `Filtered ${removed}/${beforeFilter} results that don't match "${show.title} ${label}"`,
      });
      const filteredOutTitles = allReleases
        .filter(r => !isRelevantMatch(r.title, show.title, season, episode))
        .map(r => r.title);
      db.logPipelineEvent({
        showId, seasonNumber: season, episodeNumber: episode ?? null,
        stage: 'SEARCHING', eventType: 'release_filtered', reasonCode: 'TITLE_OR_SEASON_MISMATCH',
        message: `${removed} release(s) filtered out - don't match "${show.title} ${label}"`,
        metadata: { count: removed, sample: filteredOutTitles.slice(0, 50) },
      });
    }

    // Score every title-matched result, then split into accepted/rejected -
    // rejected releases used to be thrown away here entirely (§2 of the
    // pipeline design brief: "29 rejected" with no way to see which releases
    // or why). They're logged as one aggregate event with a per-release
    // breakdown in metadata rather than one row each, since a single search
    // can produce dozens of rejects and this table is written to often.
    const scored = filtered.map((r): ScoredRelease => ({ ...r, score: qualityEngine.getReleaseScore(r.title, profileId) }));
    const rejected = scored.filter(r => r.score.rejected);
    const releases = scored
      .filter(r => !r.score.rejected)
      .sort((a, b) => b.score.totalScore - a.score.totalScore);

    if (rejected.length > 0) {
      const breakdown: Record<string, number> = {};
      for (const r of rejected) {
        const code = r.score.rejectCode ?? 'QUALITY_UNKNOWN';
        breakdown[code] = (breakdown[code] ?? 0) + 1;
      }
      db.logPipelineEvent({
        showId, seasonNumber: season, episodeNumber: episode ?? null,
        stage: 'SEARCHING', eventType: 'release_rejected',
        message: `${rejected.length} release(s) rejected by quality profile`,
        metadata: {
          count: rejected.length,
          breakdown,
          releases: rejected.slice(0, 50).map(r => ({ title: r.title, code: r.score.rejectCode, reason: r.score.rejectReason })),
        },
      });
    }

    db.logPipelineEvent({
      showId, seasonNumber: season, episodeNumber: episode ?? null,
      stage: 'SEARCHING', eventType: 'search_completed',
      message: `Queried ${indexers.length} indexer(s), found ${allReleases.length} release(s), ${releases.length} passed filtering`,
      metadata: { indexersQueried: indexers.length, resultsFound: allReleases.length, passedFiltering: releases.length },
    });

    if (releases.length > 0) {
      logDebug({
        type: 'grabber',
        level: 'info',
        source: 'GrabberService',
        message: `Best release: "${releases[0]!.title}" (score: ${releases[0]!.score.totalScore})`,
      });
      db.logPipelineEvent({
        showId, seasonNumber: season, episodeNumber: episode ?? null,
        stage: 'SEARCHING', eventType: 'release_selected',
        message: `Top pick selected: "${releases[0]!.title}" (score: ${releases[0]!.score.totalScore})`,
        releaseTitle: releases[0]!.title,
      });
    } else {
      logDebug({
        type: 'grabber',
        level: 'warn',
        source: 'GrabberService',
        message: `No qualifying releases found for "${show.title} ${label}" from ${indexers.length} indexer(s)`,
      });
      db.logPipelineEvent({
        showId, seasonNumber: season, episodeNumber: episode ?? null,
        stage: 'WANTED', eventType: 'no_qualifying_releases', reasonCode: 'NO_RESULTS_FOUND',
        message: `No qualifying releases found for "${show.title} ${label}" from ${indexers.length} indexer(s)`,
      });
    }

    return { releases, profileId };
  }

  /**
   * Searches for the best release for a specific episode and grabs it,
   * skipping the grab entirely if it wouldn't be an upgrade over the file
   * already on disk.
   */
  async grabBestRelease(showId: string, season: number, episode: number): Promise<GrabResult> {
    logDebug({
      type: 'grabber',
      level: 'info',
      source: 'GrabberService',
      message: `Best release grab for show=${showId} S${pad(season)}E${pad(episode)}`,
    });

    const result = await this.searchReleases(showId, season, episode);
    if ('error' in result) {
      logDebug({ type: 'grabber', level: 'warn', source: 'GrabberService', message: result.error });
      return { success: false, message: result.error };
    }

    const { releases, profileId } = result;
    if (releases.length === 0) {
      logDebug({ type: 'grabber', level: 'warn', source: 'GrabberService', message: 'No releases found to grab' });
      return { success: false, message: 'No releases found' };
    }

    const best = releases[0]!;

    const existingEp = db.getEpisode(showId, season, episode);
    if (existingEp && existingEp.file_path) {
      const existingFilename = path.basename(existingEp.file_path);
      if (!qualityEngine.shouldUpgrade(existingFilename, best.title, profileId)) {
        logDebug({
          type: 'grabber', level: 'info', source: 'GrabberService',
          message: `Skipping grab — "${best.title}" is not an upgrade over "${existingFilename}"`,
        });
        db.logPipelineEvent({
          showId, seasonNumber: season, episodeNumber: episode,
          stage: 'WANTED', eventType: 'not_upgrade', reasonCode: 'NOT_AN_UPGRADE',
          message: `"${best.title}" is not an upgrade over the existing file`,
          releaseTitle: best.title,
        });
        return {
          success: false,
          message: `Best found release (${best.title}) is not an upgrade over existing file.`,
          bestRelease: best,
        };
      }
    }

    return this.grabRelease(best, { showId, season, episode });
  }

  /**
   * Searches for the best release for an entire season (season packs
   * included) and grabs it. There's no per-episode upgrade check here -
   * a pack can span episodes that are each at a different existing
   * quality, so this is intentionally a coarser action than the
   * per-episode grab.
   */
  async grabBestSeasonRelease(showId: string, season: number): Promise<GrabResult> {
    logDebug({
      type: 'grabber',
      level: 'info',
      source: 'GrabberService',
      message: `Best season grab for show=${showId} S${pad(season)}`,
    });

    const result = await this.searchReleases(showId, season);
    if ('error' in result) {
      logDebug({ type: 'grabber', level: 'warn', source: 'GrabberService', message: result.error });
      return { success: false, message: result.error };
    }

    const { releases } = result;
    if (releases.length === 0) {
      logDebug({ type: 'grabber', level: 'warn', source: 'GrabberService', message: 'No season releases found' });
      return { success: false, message: 'No releases found for this season' };
    }

    return this.grabRelease(releases[0]!, { showId, season });
  }

  /**
   * Grabs a specific, already-found release. Routes through TorBox if
   * configured, otherwise falls back to the indexer's built-in grab
   * (blackhole folder).
   *
   * `context` ties this grab back to a show/season/episode for the pipeline
   * event log - it's optional so callers that don't have that context
   * (interactive search, for instance) keep working unchanged, they just
   * won't show up in that item's trace.
   */
  async grabRelease(release: ScoredRelease, context?: { showId: string; season?: number; episode?: number }): Promise<GrabResult> {
    logDebug({
      type: 'grabber',
      level: 'info',
      source: release.indexer.name,
      message: `Grabbing "${release.title}" (score: ${release.score.totalScore})`,
    });

    // When TorBox is configured, send the release directly instead of writing
    // .torrent/.magnet files to a blackhole folder. This resolves once TorBox
    // has accepted the torrent - the actual download continues in the
    // background and reports its own completion/failure via db events (see
    // TorboxDownloadClient.submitReleaseBackground), so this grab call itself
    // stays fast regardless of how long the torrent takes to finish.
    const torboxCfg = this.config.downloadClient?.torbox;
    if (torboxCfg?.apiKey) {
      const torbox = new TorboxDownloadClient(resolveTorboxConfig(this.config));

      const result = await torbox.submitReleaseBackground(release);

      if (result.ok) {
        logDebug({ type: 'grabber', level: 'info', source: 'TorBox', message: result.message });
        db.logEvent({ type: 'grab', entityType: 'release', message: result.message });
        if (context) {
          db.logPipelineEvent({
            showId: context.showId, seasonNumber: context.season, episodeNumber: context.episode,
            stage: 'GRABBED', eventType: 'grab_sent', reasonCode: 'GRAB_SUCCEEDED',
            message: result.message, releaseTitle: release.title, indexerName: 'TorBox',
          });
        }
        return { success: true, message: result.message, release };
      }

      logDebug({ type: 'grabber', level: 'warn', source: 'TorBox', message: `${result.message} — falling back to indexer grab` });
    }

    // Fallback: indexer's built-in grab (writes .torrent/.magnet to blackhole folder)
    const grabbed = await release.indexer.grab(release).catch(e => {
      logDebug({
        type: 'grabber', level: 'error', source: release.indexer.name,
        message: `Grab failed for "${release.title}"`,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    });

    if (!grabbed) {
      logDebug({
        type: 'grabber', level: 'error', source: release.indexer.name,
        message: `Grab returned false for "${release.title}"`,
      });
      if (context) {
        db.logPipelineEvent({
          showId: context.showId, seasonNumber: context.season, episodeNumber: context.episode,
          stage: 'FAILED', eventType: 'grab_failed', reasonCode: 'GRAB_FAILED_NO_CLIENT',
          message: `Grab failed for "${release.title}". Check that a Download Client is configured.`,
          releaseTitle: release.title, indexerName: release.indexer.name,
        });
      }
      return {
        success: false,
        message: `Grab failed for "${release.title}". Check that a Download Client is configured.`,
        bestRelease: release,
      };
    }

    logDebug({
      type: 'grabber', level: 'info', source: release.indexer.name,
      message: `Successfully grabbed "${release.title}"`,
    });

    db.logEvent({ type: 'grab', entityType: 'release', message: `Grabbed ${release.title}` });
    if (context) {
      db.logPipelineEvent({
        showId: context.showId, seasonNumber: context.season, episodeNumber: context.episode,
        stage: 'GRABBED', eventType: 'grab_sent', reasonCode: 'GRAB_SUCCEEDED',
        message: `Grabbed "${release.title}"`, releaseTitle: release.title, indexerName: release.indexer.name,
      });
    }

    return { success: true, message: `Grabbed ${release.title}`, release };
  }

  private getEnabledIndexers(opts?: { libraryType?: any }): Indexer[] {
    const all: { id: string; instance: Indexer }[] = [];

    // Load Prowlarr if configured and enabled
    const prowlarrConfig = db.getSetting('prowlarr');
    if (prowlarrConfig) {
      try {
        const raw = typeof prowlarrConfig === 'string' ? JSON.parse(prowlarrConfig) : prowlarrConfig;
        const config = ProwlarrConfigSchema.parse(raw);
        if (config.enabled) {
          all.push({ id: 'prowlarr', instance: IndexerFactory.create('prowlarr', config) });
        } else {
          debugLog('[Grabber] Prowlarr is disabled via settings, skipping');
        }
      } catch (e) {
        console.error('[Grabber] Prowlarr is configured but invalid, skipping:', e);
      }
    }

    // Load native indexers
    const nativeRaw = db.getSetting('nativeIndexers');
    if (nativeRaw) {
      try {
        const nativeConfigs: NativeIndexerConfig[] = JSON.parse(
          typeof nativeRaw === 'string' ? nativeRaw : nativeRaw
        );
        for (const cfg of nativeConfigs) {
          if (!cfg.enabled) continue;
          try {
            all.push({ id: cfg.id, instance: IndexerFactory.create('native', cfg) });
          } catch (e) {
            console.error(`[Grabber] Failed to create native indexer ${cfg.id}:`, e);
          }
        }
      } catch (e) {
        console.error('[Grabber] Native indexers config is invalid, skipping:', e);
      }
    }

    // If a library type specifies indexers, intersect with enabled indexers.
    // library_types.indexers is the sole source of truth here - the legacy
    // quality_profiles.indexers fallback that used to sit below this was
    // removed along with the column (design-brief-quality-profile-library-type-rework.md §4).
    // An empty/absent indexers array means "use all enabled indexers".
    if (opts?.libraryType?.indexers && Array.isArray(opts.libraryType.indexers) && opts.libraryType.indexers.length > 0) {
      return all.filter(i => opts.libraryType.indexers.includes(i.id)).map(i => i.instance);
    }

    return all.map(i => i.instance);
  }
}
