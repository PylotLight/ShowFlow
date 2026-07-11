import { db, type Config, ProwlarrConfigSchema } from '../db';
import path from 'node:path';
import { IndexerFactory } from '../providers/indexers/factory';
import type { Indexer, IndexerResult } from '../providers/indexers/types';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { debugLog } from './debug';

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
  async searchReleases(
    showId: string,
    season: number,
    episode?: number
  ): Promise<{ releases: ScoredRelease[]; profileId: string } | { error: string }> {
    const show = db.getShow(showId);
    if (!show) return { error: `Show ${showId} not found` };

    const profileId = show.profile || 'standard';
    const indexers = this.getEnabledIndexers();
    if (indexers.length === 0) {
      return { error: 'No indexers configured. Add a Prowlarr connection in Settings > Indexers.' };
    }

    const query =
      episode != null
        ? `${show.title} S${pad(season)}E${pad(episode)}`
        : `${show.title} S${pad(season)}`;

    const allReleases: (IndexerResult & { indexer: Indexer })[] = [];
    for (const indexer of indexers) {
      try {
        const results = await indexer.search(query, { type: 'tvsearch', categories: [TV_CATEGORY] });
        allReleases.push(...results.map(r => ({ ...r, indexer })));
      } catch (e) {
        console.error(`[Grabber] Error searching with indexer ${indexer.name}:`, e);
      }
    }

    const releases = allReleases
      .map((r): ScoredRelease => ({ ...r, score: qualityEngine.getReleaseScore(r.title, profileId) }))
      .sort((a, b) => b.score.totalScore - a.score.totalScore);

    return { releases, profileId };
  }

  /**
   * Searches for the best release for a specific episode and grabs it,
   * skipping the grab entirely if it wouldn't be an upgrade over the file
   * already on disk.
   */
  async grabBestRelease(showId: string, season: number, episode: number): Promise<GrabResult> {
    debugLog('GrabberService: Searching for best release', { showId, season, episode });

    const result = await this.searchReleases(showId, season, episode);
    if ('error' in result) return { success: false, message: result.error };

    const { releases, profileId } = result;
    if (releases.length === 0) return { success: false, message: 'No releases found' };

    const best = releases[0];

    const existingEp = db.getEpisode(showId, season, episode);
    if (existingEp && existingEp.file_path) {
      const existingFilename = path.basename(existingEp.file_path);
      if (!qualityEngine.shouldUpgrade(existingFilename, best.title, profileId)) {
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
    debugLog('GrabberService: Searching for best season release', { showId, season });

    const result = await this.searchReleases(showId, season);
    if ('error' in result) return { success: false, message: result.error };

    const { releases } = result;
    if (releases.length === 0) return { success: false, message: 'No releases found for this season' };

    return this.grabRelease(releases[0]);
  }

  /** Grabs a specific, already-found release via the indexer that found it. */
  async grabRelease(release: ScoredRelease): Promise<GrabResult> {
    const grabbed = await release.indexer.grab(release).catch(e => {
      console.error(`[Grabber] Grab failed for ${release.title}:`, e);
      return false;
    });

    if (!grabbed) {
      return {
        success: false,
        message: `Grab failed for "${release.title}". Check that a Download Client is configured in Prowlarr.`,
        bestRelease: release,
      };
    }

    db.logEvent({ type: 'grab', entityType: 'release', message: `Grabbed ${release.title}` });

    return { success: true, message: `Grabbed ${release.title}`, release };
  }

  private getEnabledIndexers(): Indexer[] {
    // This is a placeholder for a proper multi-indexer configuration system.
    // For now, we assume Prowlarr is configured in the settings.
    const prowlarrConfig = db.getSetting('prowlarr');
    if (!prowlarrConfig) return [];

    try {
      const raw = typeof prowlarrConfig === 'string' ? JSON.parse(prowlarrConfig) : prowlarrConfig;
      const config = ProwlarrConfigSchema.parse(raw);
      return [IndexerFactory.create('prowlarr', config)];
    } catch (e) {
      console.error('[Grabber] Prowlarr is configured but invalid, skipping:', e);
      return [];
    }
  }
}
