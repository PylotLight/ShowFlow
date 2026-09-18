import { db, type Config, ProwlarrConfigSchema } from '../db';
import path from 'node:path';
import { IndexerFactory } from '../providers/indexers/factory';
import type { Indexer, IndexerResult } from '../providers/indexers/types';
import type { NativeIndexerConfig } from '../providers/indexers/native/types';
import { NATIVE_INDEXER_META } from '../providers/indexers/native/types';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { isRelevantMovieMatch } from './movie_match';
import { debugLog, logDebug } from './debug';
import { TorboxDownloadClient, resolveTorboxConfig } from './download_clients';
import type { DownloadManager } from './download_manager';
import { reconcileShowAirWindows } from './air_window';

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'it', 'its']);

// TV shows live under Prowlarr's "5000" parent category (5010 SD, 5030 HD,
// 5040 UHD, etc. all roll up under it), so scoping searches to it keeps
// movie-only indexers/junk results out without needing per-indexer category
// mapping.
const TV_CATEGORY = 5000;

// Films live under Prowlarr's "2000" parent category (per the indexer
// category map in providers/indexers/types.ts) — same scoping rationale
// as TV_CATEGORY above.
const MOVIE_CATEGORY = 2000;

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

// Season identifier for a season-scoped search: S03 / S3 (including the
// S03E04 episode form), "Season 3", and 3x04. Specials match S00,
// "Season 0", or the word "special(s)".
function seasonIdentifier(season: number): RegExp {
  if (season === 0) {
    return /(?:s0*0(?:e\d|[^a-z0-9]|$)|season\s+0\b|specials?)/i;
  }
  const n = String(season);
  return new RegExp(`(?:s0*${n}(?:e\\d|[^a-z0-9]|$)|season\\s+0*${n}\\b|(?:^|[^a-z0-9])0*${n}x\\d)`, 'i');
}

export function isRelevantMatch(title: string, showTitle: string, season: number, episode?: number, opts?: { absolute?: boolean }): boolean {
  const lower = title.toLowerCase();
  const norm = lower.replace(/[._\s-]+/g, ' ');
  // A trailing "(YYYY)" suffix (TVDB-style disambiguation, e.g.
  // "Dark Matter (2024)") is metadata, not title: release names carry the
  // bare year or none at all, so requiring the parenthesized token drops
  // every legitimate match. Match on the bare words instead, but reject
  // when the release carries a *conflicting* year (remake protection).
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(showTitle);
  const showYear = yearMatch ? yearMatch[1] : null;
  const bareTitle = showYear ? showTitle.replace(/\(\d{4}\)/g, '') : showTitle;
  const showNorm = bareTitle.toLowerCase().replace(/[._\s-]+/g, ' ');

  // Extract significant words from the show title (no stopwords, no single chars)
  const showWords = showNorm.split(/\s+/).filter(w => !STOPWORDS.has(w) && w.length > 1);
  if (showWords.length === 0) return false;

  // Check how many significant show-title words appear in the release title
  const wordMatches = showWords.filter(w => norm.includes(w)).length;
  const enoughTitleWords = wordMatches >= Math.max(1, Math.ceil(showWords.length * 0.75));
  if (!enoughTitleWords) return false;

  // Year conflict: the release names a different year than the show.
  if (showYear) {
    const releaseYears = new Set<string>();
    for (const m of norm.matchAll(/\b(19\d{2}|20\d{2})\b/g)) releaseYears.add(m[1]!);
    if (releaseYears.size > 0 && !releaseYears.has(showYear)) return false;
  }

  // Check for a season/episode identifier using zero-padded flexible regex
  // Handles S01E01, S1E1, S01E1, S1E01, S01E01-08 (packs), S01 E01, etc.
  if (episode != null) {
    const hasEp = new RegExp(`s0*${season}e0*${episode}(?:[^a-z0-9]|$)`, 'i').test(norm);
    return hasEp;
  }

  // Season-wide searches must also carry a season identifier — otherwise
  // every other season's episodes pass the title check and a season
  // Browse reads as a full-series search. Absolute-numbered series
  // (anime) carry no season marker in release titles, so they keep the
  // title-words-only behavior.
  if (opts?.absolute) return enoughTitleWords;
  return enoughTitleWords && seasonIdentifier(season).test(norm);
}

export class GrabberService {
  /**
   * Optional download-manager reference. When present, TorBox grabs are
   * routed through the manager's long-lived TorBox client so download
   * tracking state (getActiveDownloads, background waitForDownload tasks)
   * stays consistent across the app. When absent (legacy construction
   * paths), we fall back to an ephemeral client.
   */
  constructor(
    private config: Config,
    private downloadManager?: DownloadManager,
  ) {}

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
  ): Promise<{ releases: ScoredRelease[]; profileId: string; sceneSeason: number | null; sceneEpisode: number | null; sceneSeasons: number[] } | { error: string }> {
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

    // Native exact-match indexers (Knaben `search_type: 100%`) require every
    // query token to appear in the title, so a TVDB-style "Show (2024)"
    // suffix poisons the query — release names never contain the parens.
    // Search the bare title; isRelevantMatch still guards the year.
    const queryTitle = show.title.replace(/\s*\(\d{4}\)\s*$/, '').trim() || show.title;

    // Anime season-split translation (provider -> scene): the episode table
    // stores provider-native numbering (e.g. TVDB flat S01E58) but release
    // files/indexers use scene numbering (e.g. S04E22). When the mapping is
    // enabled and has a row for this episode, search the scene name —
    // searching the provider name finds nothing (the reported Honzuki bug:
    // "searching S01 instead of S04").
    let searchSeason = season;
    let searchEpisode = episode;
    let searchAbsolute: number | null = null;
    let mappedLabel: string | null = null;
    if (episode != null && seriesType !== 'absolute') {
      try {
        if (db.isEpisodeMappingEnabled(showId)) {
          const row = db.findTargetMapping(showId, season, episode);
          if (row && row.scene_season != null && row.scene_episode != null) {
            searchSeason = row.scene_season;
            searchEpisode = row.scene_episode;
            mappedLabel = `S${pad(row.scene_season)}E${pad(row.scene_episode)}`;
          } else {
            // Visible fallback reason: without a row whose *target* is this
            // provider episode (e.g. no target S01E49 — typical when rows
            // were bulk-locked as scene==provider identities), the search
            // can only use provider numbering.
            let rowCount = -1;
            try { rowCount = db.listEpisodeMappings(showId).length; } catch { /* ignore */ }
            logDebug({
              type: 'grabber',
              level: 'info',
              source: 'GrabberService',
              message: `No scene mapping for "${show.title} S${pad(season)}E${pad(episode)}" (${rowCount} mapping rows) — searching provider numbering`,
            });
          }
        }
      } catch {
        // Mapping lookup is best-effort; fall back to provider numbering.
      }
    } else if (episode != null && seriesType === 'absolute') {
      try {
        if (db.isEpisodeMappingEnabled(showId)) {
          const row = db.findTargetAbsoluteMapping(showId, episode);
          if (row && row.scene_absolute != null && row.scene_absolute !== episode) {
            searchAbsolute = row.scene_absolute;
            mappedLabel = `#${row.scene_absolute}`;
          }
        }
      } catch {
        // Best-effort only.
      }
    }

    const providerQuery =
      episode != null
        ? seriesType === 'absolute'
          ? `${queryTitle} ${String(episode).padStart(3, '0')}`
          : `${queryTitle} S${pad(season)}E${pad(episode)}`
        : `${queryTitle} S${pad(season)}`;
    const sceneQuery =
      episode != null
        ? seriesType === 'absolute'
          ? searchAbsolute != null
            ? `${queryTitle} ${String(searchAbsolute).padStart(3, '0')}`
            : providerQuery
          : (searchEpisode != null
              ? `${queryTitle} S${pad(searchSeason)}E${pad(searchEpisode)}`
              : providerQuery)
        : providerQuery;

    // Season-pack searches span scene seasons: one provider season (e.g.
    // S01) can map to several scene seasons (S01-S04). Search each scene
    // season plus the provider season so packs under either naming are found.
    let queries: string[];
    let packSceneSeasons: number[] = [];
    if (episode == null && seriesType !== 'absolute') {
      queries = [providerQuery];
      try {
        if (db.isEpisodeMappingEnabled(showId)) {
          const sceneSeasons = db.listSceneSeasonsForTarget(showId, season);
          packSceneSeasons = sceneSeasons;
          for (const ss of sceneSeasons) {
            const q = `${queryTitle} S${pad(ss)}`;
            if (!queries.includes(q)) queries.push(q);
          }
          if (sceneSeasons.length > 0) {
            mappedLabel = sceneSeasons.map(s => `S${pad(s)}`).join(', ');
          }
        }
      } catch {
        // Best-effort only.
      }
    } else {
      queries = mappedLabel && sceneQuery !== providerQuery ? [sceneQuery, providerQuery] : [providerQuery];
    }

    const label = episode != null
      ? `S${pad(season)}E${pad(episode)}`
      : `S${pad(season)}`;

    logDebug({
      type: 'grabber',
      level: 'info',
      source: 'GrabberService',
      message: mappedLabel
        ? `Searching ${indexers.length} indexers for "${show.title} ${label}" (scene: "${mappedLabel}", queries: ${queries.map(q => `"${q}"`).join(', ')})`
        : `Searching ${indexers.length} indexers for "${show.title} ${label}" (query: "${providerQuery}")`,
    });

    const category = anime ? 5070 : TV_CATEGORY;
    const allReleases: (IndexerResult & { indexer: Indexer })[] = [];
    for (const indexer of indexers) {
      for (const query of queries) {
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
    }

    // Multi-query searches (scene + provider) can return the same release
    // twice — dedupe by indexer + guid so counts/scores stay honest.
    if (queries.length > 1 && allReleases.length > 1) {
      const seen = new Set<string>();
      const deduped = allReleases.filter(r => {
        const key = `${r.indexer.name}::${r.guid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      allReleases.length = 0;
      allReleases.push(...deduped);
    }

    const beforeFilter = allReleases.length;
    const matchOpts = { absolute: seriesType !== 'standard' };
    // When mapped, accept either the scene numbering (what releases use)
    // or the provider numbering (some indexers mirror TVDB). Season packs
    // accept any scene season mapping to the provider season.
    const matches = (title: string): boolean => {
      if (episode != null) {
        if (isRelevantMatch(title, show.title, searchSeason, searchEpisode, matchOpts)) return true;
        if (mappedLabel && (searchSeason !== season || searchEpisode !== episode)) {
          return isRelevantMatch(title, show.title, season, episode, matchOpts);
        }
        return false;
      }
      if (isRelevantMatch(title, show.title, season, undefined, matchOpts)) return true;
      for (const ss of packSceneSeasons) {
        if (isRelevantMatch(title, show.title, ss, undefined, matchOpts)) return true;
      }
      return false;
    };
    const filtered = allReleases.filter(r => matches(r.title));
    const removed = beforeFilter - filtered.length;
    if (removed > 0) {
      logDebug({
        type: 'grabber',
        level: 'info',
        source: 'GrabberService',
        message: mappedLabel
          ? `Filtered ${removed}/${beforeFilter} results that don't match "${show.title} ${label}" (scene: "${mappedLabel}")`
          : `Filtered ${removed}/${beforeFilter} results that don't match "${show.title} ${label}"`,
      });
      const filteredOutTitles = allReleases
        .filter(r => !matches(r.title))
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

    // Scene numbering used for this search (nulls when the mapping didn't
    // apply) so API consumers can show it, e.g. "S01E49 (scene S04E13)".
    // Absolute-numbered series report the scene absolute number instead.
    const sceneMapped = mappedLabel != null && searchEpisode != null;
    return {
      releases,
      profileId,
      sceneSeason: sceneMapped && seriesType !== 'absolute' ? searchSeason : null,
      sceneEpisode: sceneMapped
        ? (seriesType === 'absolute' ? (searchAbsolute ?? searchEpisode!) : searchEpisode!)
        : null,
      sceneSeasons: packSceneSeasons,
    };
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

    // Persistent series -> release -> episode tracking. When we later import
    // a file whose name is too generic to resolve, this lets the import step
    // narrow the search to the exact show/season/episode this grab target.
    const trackGrab = () => {
      if (!context?.showId) return;
      try {
        db.recordGrabbedRelease({
          showId: context.showId,
          season: context.season ?? null,
          episode: context.episode ?? null,
          releaseTitle: release.title,
          indexerName: release.indexer.name,
          publishDate: release.publishDate ?? null,
        });
        // Observe the real publish date -> tighten this show's air-window
        // forecast. Non-fatal: the grab itself already succeeded.
        try {
          reconcileShowAirWindows(context.showId, false);
        } catch (err) {
          debugLog('Air-window reconcile after grab failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        debugLog('Failed to record grabbed release (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // When TorBox is configured, send the release directly instead of writing
    // .torrent/.magnet files to a blackhole folder. This resolves once TorBox
    // has accepted the torrent - the actual download continues in the
    // background and reports its own completion/failure via db events (see
    // TorboxDownloadClient.submitReleaseBackground), so this grab call itself
    // stays fast regardless of how long the torrent takes to finish.
    const torboxCfg = this.config.downloadClient?.torbox;
    if (torboxCfg?.apiKey) {
      // Prefer the Download Manager's long-lived TorBox client when one is
      // running — it owns the background waitForDownload tasks and the
      // "active downloads" list surfaced on the Queue page. Creating a new
      // ephemeral client per grab is a legacy fallback and means the Queue
      // page won't see the download.
      const torbox = this.downloadManager?.getTorboxClient()
        ?? new TorboxDownloadClient(resolveTorboxConfig(this.config));

      const result = await torbox.submitReleaseBackground(release);

      if (result.ok) {
        logDebug({ type: 'grabber', level: 'info', source: 'TorBox', message: result.message });
        db.logEvent({ type: 'grab', entityType: 'release', message: result.message });
        trackGrab();
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
    trackGrab();
    if (context) {
      db.logPipelineEvent({
        showId: context.showId, seasonNumber: context.season, episodeNumber: context.episode,
        stage: 'GRABBED', eventType: 'grab_sent', reasonCode: 'GRAB_SUCCEEDED',
        message: `Grabbed "${release.title}"`, releaseTitle: release.title, indexerName: release.indexer.name,
      });
    }

    return { success: true, message: `Grabbed ${release.title}`, release };
  }

  /**
   * Searches all configured indexers for a movie ("Title YYYY", movie
   * category) and scores every result against the show's quality profile.
   * Mirrors searchReleases minus the season/episode scoping — films are
   * single-shot grabs.
   */
  async searchMovieReleases(
    showId: string,
  ): Promise<{ releases: ScoredRelease[]; profileId: string } | { error: string }> {
    const show = db.getShow(showId);
    if (!show) return { error: `Show ${showId} not found` };

    const libraryType = show.library_type_id ? db.getLibraryType(show.library_type_id) : null;
    const profileId = libraryType?.quality_profile_id ?? db.resolveProfileId(show.profile) ?? '';
    const indexers = this.getEnabledIndexers({ libraryType });
    if (indexers.length === 0) {
      const message = 'No indexers configured. Add a Prowlarr or Native indexer in Settings > Indexers.';
      db.logPipelineEvent({
        showId, stage: 'FAILED', eventType: 'search_no_indexers', reasonCode: 'NO_INDEXERS_CONFIGURED', message,
      });
      return { error: message };
    }

    const queryTitle = show.title.replace(/\s*\(\d{4}\)\s*$/, '').trim() || show.title;
    const query = show.year ? `${queryTitle} ${show.year}` : queryTitle;

    logDebug({
      type: 'grabber', level: 'info', source: 'GrabberService',
      message: `Searching ${indexers.length} indexers for movie "${show.title}" (query: "${query}")`,
    });

    const allReleases: (IndexerResult & { indexer: Indexer })[] = [];
    for (const indexer of indexers) {
      try {
        const results = await indexer.search(query, { type: 'movie', categories: [MOVIE_CATEGORY] });
        logDebug({
          type: 'grabber', level: results.length > 0 ? 'info' : 'debug', source: indexer.name,
          message: `Found ${results.length} releases for "${query}"`,
        });
        allReleases.push(...results.map(r => ({ ...r, indexer })));
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        logDebug({
          type: 'grabber', level: 'error', source: indexer.name,
          message: `Search error for "${query}"`, error: errorMessage,
        });
        db.logPipelineEvent({
          showId, stage: 'SEARCHING', eventType: 'indexer_error', reasonCode: 'INDEXER_SEARCH_ERROR',
          message: `${indexer.name} search failed: ${errorMessage}`, indexerName: indexer.name,
        });
      }
    }

    const beforeFilter = allReleases.length;
    const filtered = allReleases.filter(r => isRelevantMovieMatch(r.title, show.title, show.year ?? null));
    const removed = beforeFilter - filtered.length;
    if (removed > 0) {
      logDebug({
        type: 'grabber', level: 'info', source: 'GrabberService',
        message: `Filtered ${removed}/${beforeFilter} results that don't match movie "${show.title}"`,
      });
      db.logPipelineEvent({
        showId, stage: 'SEARCHING', eventType: 'release_filtered', reasonCode: 'TITLE_OR_SEASON_MISMATCH',
        message: `${removed} release(s) filtered out - don't match "${show.title}"`,
        metadata: { count: removed, sample: allReleases.filter(r => !isRelevantMovieMatch(r.title, show.title, show.year ?? null)).slice(0, 50).map(r => r.title) },
      });
    }

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
        showId, stage: 'SEARCHING', eventType: 'release_rejected',
        message: `${rejected.length} release(s) rejected by quality profile`,
        metadata: {
          count: rejected.length, breakdown,
          releases: rejected.slice(0, 50).map(r => ({ title: r.title, code: r.score.rejectCode, reason: r.score.rejectReason })),
        },
      });
    }

    db.logPipelineEvent({
      showId, stage: 'SEARCHING', eventType: 'search_completed',
      message: `Queried ${indexers.length} indexer(s), found ${allReleases.length} release(s), ${releases.length} passed filtering`,
      metadata: { indexersQueried: indexers.length, resultsFound: allReleases.length, passedFiltering: releases.length },
    });

    if (releases.length > 0) {
      logDebug({
        type: 'grabber', level: 'info', source: 'GrabberService',
        message: `Best release: "${releases[0]!.title}" (score: ${releases[0]!.score.totalScore})`,
      });
      db.logPipelineEvent({
        showId, stage: 'SEARCHING', eventType: 'release_selected',
        message: `Top pick selected: "${releases[0]!.title}" (score: ${releases[0]!.score.totalScore})`,
        releaseTitle: releases[0]!.title,
      });
    } else {
      logDebug({
        type: 'grabber', level: 'warn', source: 'GrabberService',
        message: `No qualifying releases found for movie "${show.title}" from ${indexers.length} indexer(s)`,
      });
      db.logPipelineEvent({
        showId, stage: 'WANTED', eventType: 'no_qualifying_releases', reasonCode: 'NO_RESULTS_FOUND',
        message: `No qualifying releases found for movie "${show.title}" from ${indexers.length} indexer(s)`,
      });
    }

    return { releases, profileId };
  }

  /**
   * Grabs the best release for a movie, skipping when it wouldn't be an
   * upgrade over the file already on disk.
   */
  async grabBestMovieRelease(showId: string): Promise<GrabResult> {
    logDebug({
      type: 'grabber', level: 'info', source: 'GrabberService',
      message: `Best movie grab for show=${showId}`,
    });

    const result = await this.searchMovieReleases(showId);
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

    const existing = db.getMovieFile(showId);
    if (existing) {
      const existingFilename = path.basename(existing.file_path);
      if (!qualityEngine.shouldUpgrade(existingFilename, best.title, profileId)) {
        logDebug({
          type: 'grabber', level: 'info', source: 'GrabberService',
          message: `Skipping grab — "${best.title}" is not an upgrade over "${existingFilename}"`,
        });
        db.logPipelineEvent({
          showId, stage: 'WANTED', eventType: 'not_upgrade', reasonCode: 'NOT_AN_UPGRADE',
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

    return this.grabRelease(best, { showId });
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
