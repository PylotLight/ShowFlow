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

    const profileId = db.resolveProfileId(show.profile) ?? '';
    const seriesType = this.getSeriesType(show);
    const anime = seriesType === 'anime' || seriesType === 'absolute';
    const indexers = this.getEnabledIndexers(profileId, seriesType);
    if (indexers.length === 0) {
      return { error: 'No indexers configured. Add a Prowlarr or Native indexer in Settings > Indexers.' };
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
        logDebug({
          type: 'grabber',
          level: 'error',
          source: indexer.name,
          message: `Search error for "${query}"`,
          error: e instanceof Error ? e.message : String(e),
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
    }

    const releases = filtered
      .map((r): ScoredRelease => ({ ...r, score: qualityEngine.getReleaseScore(r.title, profileId) }))
      .filter(r => !r.score.rejected)
      .sort((a, b) => b.score.totalScore - a.score.totalScore);

    if (releases.length > 0) {
      logDebug({
        type: 'grabber',
        level: 'info',
        source: 'GrabberService',
        message: `Best release: "${releases[0]!.title}" (score: ${releases[0]!.score.totalScore})`,
      });
    } else {
      logDebug({
        type: 'grabber',
        level: 'warn',
        source: 'GrabberService',
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
        return {
          success: false,
          message: `Best found release (${best.title}) is not an upgrade over existing file.`,
          bestRelease: best,
        };
      }
    }

    return this.grabRelease(best);
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

    return this.grabRelease(releases[0]!);
  }

  /** Grabs a specific, already-found release. Routes through TorBox if configured, otherwise falls back to the indexer's built-in grab (blackhole folder). */
  async grabRelease(release: ScoredRelease): Promise<GrabResult> {
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

    return { success: true, message: `Grabbed ${release.title}`, release };
  }

  private getEnabledIndexers(profileId?: string, seriesType?: string): Indexer[] {
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

    // If a profile specifies indexer filtering, intersect with enabled indexers
    if (profileId) {
      const allowed = db.getProfileIndexers(profileId);
      if (allowed.length > 0) {
        return all.filter(i => allowed.includes(i.id)).map(i => i.instance);
      }
    }

    return all.map(i => i.instance);
  }
}
