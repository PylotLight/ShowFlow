import { db as defaultDb, ProwlarrConfigSchema, type Config, type DatabaseManager } from '../db';
import { IndexerFactory } from '../providers/indexers/factory';
import type { Indexer, IndexerResult, RecentFeed } from '../providers/indexers/types';
import type { NativeIndexerConfig } from '../providers/indexers/native/types';
import { GrabberService, isRelevantMatch, type GrabResult, type ScoredRelease } from './grabber_service';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { GRAB_INFLIGHT_HOURS, MAX_GRABS_PER_CYCLE, isDueForSearch } from './auto_grabber';
import { FilenameParser } from '../parser';
import { listRssCandidateEpisodes, loadRssCursors, saveRssCursors, type RssCandidateEpisode, type RssCursor } from '../db/rss';
import { debugLog } from './debug';
import type { DownloadManager } from './download_manager';

/**
 * RSS sync: the cheap, "catch it the moment it's posted" half of grabbing.
 *
 * Every cycle pulls each enabled indexer's latest-releases feed (Prowlarr:
 * per-indexer newznab/torznab `t=tvsearch` with no query; native trackers
 * that have a "latest" view implement `Indexer.fetchRecent`), keeps only
 * items not seen before (per-feed cursor), matches them against tracked +
 * missing + aired episodes, scores with the show's quality profile and
 * grabs the best per episode through GrabberService.grabRelease - so the
 * pipeline_events / grabbed_releases trail is identical to a search grab.
 *
 * auto-grab stays the backfill path: it searches per episode for anything
 * RSS didn't see (feed gaps, old episodes, indexers with no feed). A grab
 * here records grabbed_releases, so auto-grab's in-flight guard skips it.
 *
 * Upgrades are out of scope: only episodes with no file on disk are
 * candidates (same as auto-grab).
 */

/** Cap on remembered guids per feed - comfortably above a feed page (~100). */
const SEEN_CAP = 1000;
const TV_CATEGORIES = [5000, 5070];

export interface RssSource {
  /** Indexer id as used by library_types.indexers: 'prowlarr' or a native id. */
  id: string;
  indexer: Indexer;
}

export interface RssSyncResult {
  feeds: number;
  feedErrors: number;
  newReleases: number;
  matchedEpisodes: number;
  grabbed: number;
  failed: number;
  /** Episodes whose best release was already grabbed for a sibling episode (multi-ep release). */
  coveredByOther: number;
  deferred: number;
}

export interface RssSyncDeps {
  db?: DatabaseManager;
  /** Override indexer discovery (tests). */
  sources?: RssSource[];
  score?: (title: string, profileId: string) => ReleaseScore;
  grab?: (release: ScoredRelease, ctx: { showId: string; season: number; episode: number }) => Promise<GrabResult>;
  nowMs?: number;
}

// ---------- cursor ----------

export function releaseKey(r: Pick<IndexerResult, 'guid' | 'infoHash' | 'downloadUrl' | 'title'>): string {
  return r.guid || r.infoHash || r.downloadUrl || r.title;
}

function pubMs(r: IndexerResult): number | null {
  if (!r.publishDate) return null;
  const t = Date.parse(r.publishDate);
  return Number.isFinite(t) ? t : null;
}

/**
 * Split a feed into never-processed items and the cursor to persist.
 * An item is new when its guid isn't remembered AND it isn't older than
 * the newest pubDate already processed (date-less items rely on the guid
 * set alone). `possibleGap` flags a feed whose oldest item is still newer
 * than the cursor - releases may have scrolled off between cycles; auto-grab
 * backfills those.
 */
export function selectNewReleases(
  cursor: RssCursor | undefined,
  items: IndexerResult[],
  nowIso = new Date().toISOString(),
): { fresh: IndexerResult[]; next: RssCursor; possibleGap: boolean } {
  const seen = new Set(cursor?.seen ?? []);
  const last = cursor?.lastPubMs ?? null;
  const fresh: IndexerResult[] = [];
  const batchKeys = new Set<string>();
  let maxPub = last;
  let minPub: number | null = null;

  for (const r of items) {
    const key = releaseKey(r);
    const t = pubMs(r);
    if (t != null) {
      if (maxPub == null || t > maxPub) maxPub = t;
      if (minPub == null || t < minPub) minPub = t;
    }
    if (seen.has(key) || batchKeys.has(key)) continue;
    if (last != null && t != null && t < last) continue;
    batchKeys.add(key);
    fresh.push(r);
  }

  const nextSeen = [...new Set([...items.map(releaseKey), ...(cursor?.seen ?? [])])].slice(0, SEEN_CAP);
  const possibleGap = cursor != null && last != null && items.length > 0 && fresh.length === items.length && minPub != null && minPub > last;
  return { fresh, next: { lastPubMs: maxPub, seen: nextSeen, updatedAt: nowIso }, possibleGap };
}

// ---------- matching ----------

export interface CandidateEpisode {
  season: number;
  episode: number;
  /** Scene numbering when an episode mapping applies (anime season splits). */
  sceneSeason?: number | null;
  sceneEpisode?: number | null;
  /** Scene absolute number (absolute-numbered series). */
  sceneAbsolute?: number | null;
}

export interface CandidateShow {
  id: string;
  title: string;
  seriesType: string;
  profileId: string;
  /** library_types.indexers restriction; null = every enabled indexer. */
  allowedIndexers: string[] | null;
  episodes: CandidateEpisode[];
}

const parser = new FilenameParser();

/**
 * Which of a show's candidate episodes a release title covers. Mirrors
 * GrabberService.searchReleases' matching (isRelevantMatch on scene
 * numbering, falling back to provider numbering when mapped), plus
 * absolute-number matching for absolute series (e.g. "[Group] Show - 012").
 */
export function matchReleaseToShow(title: string, show: CandidateShow): CandidateEpisode[] {
  const opts = { absolute: show.seriesType !== 'standard' };
  // Cheap title gate first: absolute mode returns the title-words check only.
  if (!isRelevantMatch(title, show.title, 0, undefined, { absolute: true })) return [];

  let absNumbers: number[] | null = null;
  if (show.seriesType === 'absolute') {
    const parsed = parser.parse(title);
    absNumbers = parsed && parsed.season === undefined ? parsed.absoluteNumbers ?? [] : [];
  }

  return show.episodes.filter((ep) => {
    const mapped = ep.sceneSeason != null && ep.sceneEpisode != null
      && (ep.sceneSeason !== ep.season || ep.sceneEpisode !== ep.episode);
    if (mapped && isRelevantMatch(title, show.title, ep.sceneSeason!, ep.sceneEpisode!, opts)) return true;
    if (isRelevantMatch(title, show.title, ep.season, ep.episode, opts)) return true;
    if (absNumbers && absNumbers.includes(ep.sceneAbsolute ?? ep.episode)) return true;
    return false;
  });
}

function isTvCategory(r: IndexerResult): boolean {
  if (!r.categories?.length) return true;
  // >= 100000 are indexer-specific custom cats (Prowlarr) - can't tell, keep.
  return r.categories.some(c => (c.id >= 5000 && c.id < 6000) || c.id >= 100000);
}

function epKey(showId: string, season: number, episode: number) {
  return `${showId}::${season}::${episode}`;
}

function buildCandidateShows(dbm: DatabaseManager, rows: RssCandidateEpisode[]): CandidateShow[] {
  const shows = new Map<string, CandidateShow>();
  for (const row of rows) {
    let show = shows.get(row.show_id);
    if (!show) {
      const libraryType = row.library_type_id ? dbm.getLibraryType(row.library_type_id) : null;
      const seriesType = row.series_type ?? 'standard';
      const allowed = Array.isArray(libraryType?.indexers) && libraryType.indexers.length > 0 ? libraryType.indexers as string[] : null;
      show = {
        id: row.show_id,
        title: row.show_title,
        seriesType,
        profileId: libraryType?.quality_profile_id ?? dbm.resolveProfileId(row.profile) ?? '',
        allowedIndexers: allowed,
        episodes: [],
      };
      shows.set(row.show_id, show);
    }
    const ep: CandidateEpisode = { season: row.season_number, episode: row.episode_number };
    try {
      if (dbm.isEpisodeMappingEnabled(row.show_id)) {
        if (show.seriesType === 'absolute') {
          const m = dbm.findTargetAbsoluteMapping(row.show_id, row.episode_number);
          if (m?.scene_absolute != null) ep.sceneAbsolute = m.scene_absolute;
        } else {
          const m = dbm.findTargetMapping(row.show_id, row.season_number, row.episode_number);
          if (m?.scene_season != null && m?.scene_episode != null) {
            ep.sceneSeason = m.scene_season;
            ep.sceneEpisode = m.scene_episode;
          }
        }
      }
    } catch { /* mapping is best-effort, same as the search path */ }
    show.episodes.push(ep);
  }
  return [...shows.values()];
}

// ---------- sources ----------

/** Enabled indexers that expose a latest-releases feed (same settings GrabberService reads). */
export function listRssSources(dbm: DatabaseManager = defaultDb): RssSource[] {
  const out: RssSource[] = [];
  const prowlarrRaw = dbm.getSetting('prowlarr');
  if (prowlarrRaw) {
    try {
      const cfg = ProwlarrConfigSchema.parse(typeof prowlarrRaw === 'string' ? JSON.parse(prowlarrRaw) : prowlarrRaw);
      if (cfg.enabled) out.push({ id: 'prowlarr', indexer: IndexerFactory.create('prowlarr', cfg) });
    } catch (e) {
      debugLog(`RSS sync: Prowlarr config invalid, skipping: ${e}`);
    }
  }
  const nativeRaw = dbm.getSetting('nativeIndexers');
  if (nativeRaw) {
    try {
      const configs: NativeIndexerConfig[] = JSON.parse(nativeRaw);
      for (const cfg of configs) {
        if (!cfg.enabled) continue;
        try {
          out.push({ id: cfg.id, indexer: IndexerFactory.createNative(cfg) });
        } catch (e) {
          debugLog(`RSS sync: failed to create native indexer ${cfg.id}: ${e}`);
        }
      }
    } catch (e) {
      debugLog(`RSS sync: native indexers config invalid, skipping: ${e}`);
    }
  }
  return out.filter(s => typeof s.indexer.fetchRecent === 'function');
}

// ---------- cycle ----------

const RSS_HEALTH_PREFIX = 'rss:';

export async function runRssSyncCycle(
  config: Config,
  downloadManager?: DownloadManager | null,
  deps: RssSyncDeps = {},
): Promise<RssSyncResult> {
  const dbm = deps.db ?? defaultDb;
  const result: RssSyncResult = { feeds: 0, feedErrors: 0, newReleases: 0, matchedEpisodes: 0, grabbed: 0, failed: 0, coveredByOther: 0, deferred: 0 };

  const sources = deps.sources ?? listRssSources(dbm);
  if (sources.length === 0) {
    clearStaleRssHealth(dbm, new Set());
    return result;
  }

  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const score = deps.score ?? ((title: string, profileId: string) => qualityEngine.getReleaseScore(title, profileId));
  let grabber: GrabberService | null = null;
  const grab = deps.grab ?? ((release, ctx) => {
    grabber ??= new GrabberService(config, downloadManager ?? undefined);
    return grabber.grabRelease(release, ctx);
  });

  // 1. Pull every feed; keep only never-processed items.
  const cursors = loadRssCursors(dbm);
  const fresh: { source: RssSource; release: IndexerResult }[] = [];
  const healthKeys = new Set<string>();

  const markHealth = (key: string, name: string, error?: string) => {
    const componentId = `${RSS_HEALTH_PREFIX}${key}`;
    healthKeys.add(componentId);
    try {
      if (error) {
        dbm.upsertHealthStatus({
          componentType: 'indexer', componentId, componentName: `${name} (RSS)`,
          status: 'degraded', reasonCode: 'INDEXER_SEARCH_ERROR', message: `RSS feed failed: ${error}`,
        });
      } else {
        dbm.removeHealthComponent('indexer', componentId);
      }
    } catch { /* health is best-effort */ }
  };

  for (const source of sources) {
    let feeds: RecentFeed[];
    try {
      feeds = await source.indexer.fetchRecent!({ categories: TV_CATEGORIES });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.feedErrors++;
      debugLog(`RSS sync: ${source.indexer.name} feed failed: ${msg}`);
      markHealth(source.id, source.indexer.name, msg);
      continue;
    }
    // Whole-source fetch worked: clear a stale source-level failure.
    markHealth(source.id, source.indexer.name);
    for (const feed of feeds) {
      result.feeds++;
      if (feed.error) {
        result.feedErrors++;
        debugLog(`RSS sync: feed ${feed.name} failed: ${feed.error}`);
        markHealth(feed.key, feed.name, feed.error);
        continue;
      }
      markHealth(feed.key, feed.name);
      const { fresh: items, next, possibleGap } = selectNewReleases(cursors[feed.key], feed.results, nowIso);
      cursors[feed.key] = next;
      if (possibleGap) {
        debugLog(`RSS sync: ${feed.name} - every item is new since the last cycle, older releases may have been missed (auto-grab will backfill)`);
      }
      for (const release of items) fresh.push({ source, release });
    }
  }
  clearStaleRssHealth(dbm, healthKeys);

  // Cursors advance even if matching/grabbing below fails: a release we
  // couldn't grab is auto-grab's job now, re-processing it every 15 min
  // would just re-fail.
  saveRssCursors(dbm, cursors);

  result.newReleases = fresh.length;
  if (fresh.length === 0) return finish(dbm, result);

  // 2. Match fresh releases to wanted episodes.
  const cooldownIso = new Date(nowMs - GRAB_INFLIGHT_HOURS * 3_600_000).toISOString();
  const rows = listRssCandidateEpisodes(dbm, nowIso, cooldownIso).filter(e => isDueForSearch(e, nowMs));
  if (rows.length === 0) return finish(dbm, result);
  const shows = buildCandidateShows(dbm, rows);

  const perEpisode = new Map<string, { show: CandidateShow; ep: CandidateEpisode; releases: ScoredRelease[] }>();
  for (const { source, release } of fresh) {
    if (!isTvCategory(release)) continue;
    for (const show of shows) {
      if (show.allowedIndexers && !show.allowedIndexers.includes(source.id)) continue;
      const eps = matchReleaseToShow(release.title, show);
      if (eps.length === 0) continue;
      const s = score(release.title, show.profileId);
      if (s.rejected) continue;
      const scored: ScoredRelease = { ...release, score: s, indexer: source.indexer };
      for (const ep of eps) {
        const k = epKey(show.id, ep.season, ep.episode);
        const slot = perEpisode.get(k) ?? { show, ep, releases: [] };
        slot.releases.push(scored);
        perEpisode.set(k, slot);
      }
    }
  }
  result.matchedEpisodes = perEpisode.size;

  // 3. Grab the best per episode. A multi-episode release grabbed for one
  // episode covers its siblings: record the grab for them too so the
  // in-flight guard holds them instead of grabbing the same release twice.
  const grabbedKeys = new Map<string, true>();
  let attempts = 0;
  for (const { show, ep, releases } of perEpisode.values()) {
    releases.sort((a, b) =>
      b.score.totalScore - a.score.totalScore
      || (b.seeders ?? 0) - (a.seeders ?? 0)
      || (pubMs(b) ?? 0) - (pubMs(a) ?? 0));
    const best = releases[0]!;
    const bestKey = `${best.indexer.name}::${releaseKey(best)}`;

    if (grabbedKeys.has(bestKey)) {
      result.coveredByOther++;
      try {
        dbm.recordGrabbedRelease({
          showId: show.id, season: ep.season, episode: ep.episode,
          releaseTitle: best.title, indexerName: best.indexer.name, publishDate: best.publishDate ?? null,
        });
      } catch { /* non-fatal */ }
      continue;
    }
    if (attempts >= MAX_GRABS_PER_CYCLE) {
      result.deferred++;
      continue;
    }
    attempts++;

    dbm.logPipelineEvent({
      showId: show.id, seasonNumber: ep.season, episodeNumber: ep.episode,
      stage: 'SEARCHING', eventType: 'rss_release_matched',
      message: `RSS: ${releases.length} new release(s) from feeds, top pick "${best.title}" (score: ${best.score.totalScore})`,
      releaseTitle: best.title, indexerName: best.indexer.name,
      metadata: { candidates: releases.slice(0, 10).map(r => ({ title: r.title, score: r.score.totalScore, indexer: r.indexerName })) },
    });

    try {
      const res = await grab(best, { showId: show.id, season: ep.season, episode: ep.episode });
      if (res.success) {
        result.grabbed++;
        grabbedKeys.set(bestKey, true);
      } else {
        result.failed++;
      }
    } catch (e) {
      result.failed++;
      debugLog(`RSS sync: grab error for ${show.title} S${ep.season}E${ep.episode}: ${e}`);
    }
  }

  return finish(dbm, result);
}

/** Drop health rows for RSS feeds that no longer exist (indexer disabled/removed). */
function clearStaleRssHealth(dbm: DatabaseManager, keep: Set<string>) {
  try {
    for (const row of dbm.getHealthSnapshot().byType.indexer) {
      if (row.component_id.startsWith(RSS_HEALTH_PREFIX) && !keep.has(row.component_id)) {
        dbm.removeHealthComponent('indexer', row.component_id);
      }
    }
  } catch { /* best-effort */ }
}

function finish(dbm: DatabaseManager, result: RssSyncResult): RssSyncResult {
  const line = `RSS sync: ${result.feeds} feed(s) (${result.feedErrors} failed), ${result.newReleases} new release(s), `
    + `${result.matchedEpisodes} wanted episode(s) matched, ${result.grabbed} grabbed, ${result.failed} failed`
    + (result.coveredByOther ? `, ${result.coveredByOther} covered by multi-ep release` : '')
    + (result.deferred ? `, ${result.deferred} deferred` : '');
  debugLog(line);
  if (result.matchedEpisodes > 0 || result.feedErrors > 0) {
    try {
      dbm.logEvent({ type: 'scheduler', entityType: 'task', entityId: 'rss-sync', message: line, metadata: { ...result } });
    } catch { /* non-fatal */ }
  }
  return result;
}
