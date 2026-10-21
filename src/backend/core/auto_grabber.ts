import { db as defaultDb, type Config, type DatabaseManager } from '../db';
import { GrabberService, type GrabResult } from './grabber_service';
import { listCutoffUnmetEpisodes, giveUpPolicy, MAX_UPGRADES_PER_CYCLE, type CutoffUnmetEpisode } from './cutoff';
import type { SeasonAirStats } from '../db/grabs';
import { buildAirDateTime, DEFAULT_RELEASE_DELAY_MINUTES } from './air_window';
import { debugLog } from './debug';
import type { DownloadManager } from './download_manager';

/**
 * The proactive half of the pipeline: the scheduled loop that actually
 * *drives* `GrabberService` without a human clicking "Auto" in the UI.
 *
 * Until this existed the only periodic hook was the `rss-scan` task, whose
 * body was a stub (`// RSS scanning logic would go here`) and which shipped
 * disabled - so episodes that aired overnight were never searched for and
 * silently aged into "yesterday" ungrabbed (docs/arch.md's "fully-automatic
 * per-episode grab" had all the parts but no driver).
 *
 * Selection rules (see db.listEpisodesDueForGrab for the SQL side):
 *   - tracked (`is_tracked = 1`, the per-episode monitor toggle) AND
 *     `search_mode = 'auto'` (interactive-mode episodes stay manual-only),
 *   - no file on disk yet,
 *   - the air datetime + delay has passed — recomputed live from the row's
 *     current air_date/air_time (the air-window forecast from air_window.ts;
 *     the stored `expected_release_at` is only trusted when no usable air
 *     date exists, so a stale forecast can never make a future episode due),
 *   - no successful grab recorded in the last GRAB_INFLIGHT_HOURS — the
 *     re-grab guard. Without it, every cycle would re-submit the same release
 *     while the TorBox download is still in flight (file_path only lands when
 *     the import completes), or hammer a failed download endlessly.
 *   - outside its search backoff: a scheduled search that ends without a
 *     grab backs the episode off 15m -> 1h -> 6h -> 24h (db/grabs.ts
 *     SEARCH_BACKOFF_MINUTES), so freshly aired eps are still searched every
 *     cycle at first but long-missing ones stop eating the cycle budget.
 *
 * Season packs (config.preferSeasonPacks): the first due episode of a
 * finished-airing season with >= seasonPackMinMissing missing tracked eps
 * triggers one season-pack search (shouldTrySeasonPack); a grabbed pack
 * covers the season's other due eps this cycle, a miss falls back to
 * per-episode searches.
 *
 * Cutoff upgrades (config.upgradeUntilCutoff): after the missing batch, up
 * to MAX_UPGRADES_PER_CYCLE cutoff-unmet episodes (core/cutoff.ts) get an
 * upgrade search with their own longer backoff, until the give-up policy
 * (config.upgradeGiveUpMisses / upgradeGiveUpAfterDays) stops them.
 *
 * Movies are excluded: they have no episode rows to track and no monitor
 * concept, so they stay on the manual per-title grab.
 */

/** An episode with a recorded grab newer than this is treated as in-flight
 *  (downloading / awaiting import) and skipped. If the download died, the
 *  cooldown expiring re-admits it and the next cycle can pick a different
 *  release. */
export const GRAB_INFLIGHT_HOURS = 12;

/** Max grab attempts per cycle - bounds a worst-case run after a long
 *  outage (vacation, downtime) so one tick can't spend hours on indexers. */
export const MAX_GRABS_PER_CYCLE = 25;

/** Hard wall-clock budget; remaining episodes defer to the next cycle. */
export const CYCLE_BUDGET_MS = 12 * 60 * 1000;

export interface AutoGrabCycleResult {
  due: number;
  grabbed: number;
  /** Season packs grabbed (each also counts the episodes it covers in packEpisodes). */
  packs: number;
  /** Due episodes this cycle that a grabbed season pack covered. */
  packEpisodes: number;
  /** Cutoff-unmet episodes searched for an upgrade / upgrades grabbed. */
  upgradeSearched: number;
  upgradeGrabbed: number;
  notFound: number;
  notUpgrade: number;
  failed: number;
  deferred: number;
}

/** True when the row's air datetime + delay has passed - the fallback for
 *  episodes that predate / missed the air-window forecast. */
function isPastFallbackWindow(
  airDate: string | null,
  airTime: string | null,
  delayMinutes: number | null,
  nowMs: number,
): boolean {
  const airDt = buildAirDateTime(airDate, airTime);
  if (!airDt) return false;
  return nowMs >= airDt.getTime() + (delayMinutes ?? DEFAULT_RELEASE_DELAY_MINUTES) * 60_000;
}

/**
 * True when an episode is actually due for a search this cycle.
 *
 * The air datetime + delay is recomputed live from the row's current
 * air_date/air_time (same math as air_window.ts) rather than trusting the
 * stored `expected_release_at` — a stale forecast left behind from an older,
 * earlier air date would otherwise keep a future episode "due" until the
 * next metadata sync corrects it. The stored forecast is only trusted when
 * there is no usable air date to compute from (TBA rows never reach here
 * from the SQL side, but manual callers might).
 */
export function isDueForSearch(  ep: { air_date: string | null; air_time: string | null; expected_release_at: string | null; release_delay_minutes: number | null },
  nowMs: number,
): boolean {
  if (ep.air_date && buildAirDateTime(ep.air_date, ep.air_time)) {
    return isPastFallbackWindow(ep.air_date, ep.air_time, ep.release_delay_minutes, nowMs);
  }
  // No (parseable) air date: trust the stored forecast, if any.
  if (!ep.expected_release_at) return false;
  return new Date(ep.expected_release_at).getTime() <= nowMs;
}

/**
 * Bucket an unsuccessful grabBestRelease result for the cycle summary.
 * Every one of these is a "searched, nothing grabbed" outcome and backs
 * the episode off (db.recordEpisodeSearchMiss).
 */
export function classifyMiss(message: string): 'notUpgrade' | 'notFound' | 'failed' {
  if (message.includes('not an upgrade')) return 'notUpgrade';
  if (message.includes('No releases found')) return 'notFound';
  return 'failed';
}

/** A season's newest episode must be at least this old (or a later season
 *  must exist) before it counts as finished airing - metadata often lists
 *  only the episodes aired so far, so "every listed ep has aired" alone
 *  would grab packs for a season mid-run. */
export const PACK_SETTLE_DAYS = 7;

export interface SeasonPackDecisionInput {
  season: number;
  seriesType: string | null;
  /** Show has an episode mapping (anime season splits) - packs map unreliably. */
  mapped: boolean;
  stats: SeasonAirStats;
  minMissing: number;
  nowMs: number;
}

/**
 * Should auto mode try a whole-season pack before per-episode searches?
 * Only for a real, numbered (not specials, not absolute-numbered) season
 * that has finished airing and is missing at least `minMissing` tracked
 * episodes.
 */
export function shouldTrySeasonPack(i: SeasonPackDecisionInput): boolean {
  if (i.season <= 0) return false;
  if (i.seriesType === 'absolute' || i.seriesType === 'movie') return false;
  if (i.mapped) return false;
  const { stats } = i;
  if (stats.total < 2 || stats.unaired > 0) return false;
  if (stats.missingTracked < Math.max(1, i.minMissing)) return false;
  if (stats.maxSeason > i.season) return true;
  if (!stats.lastAirDate) return false;
  const last = Date.parse(stats.lastAirDate);
  if (!Number.isFinite(last)) return false;
  return i.nowMs - last >= PACK_SETTLE_DAYS * 86_400_000;
}

/** What runAutoGrabCycle needs from the grabber (tests stub it). */
export type AutoGrabber = Pick<GrabberService, 'grabBestRelease' | 'grabSeasonPack' | 'grabUpgradeRelease'>;

export interface AutoGrabDeps {
  db?: DatabaseManager;
  grabber?: AutoGrabber;
  nowMs?: number;
  /** Override the cutoff-unmet pool (tests; the real one needs the quality engine). */
  listUpgrades?: (nowMs: number, cooldownIso: string) => CutoffUnmetEpisode[];
}

export async function runAutoGrabCycle(
  config: Config,
  downloadManager?: DownloadManager | null,
  deps: AutoGrabDeps = {},
): Promise<AutoGrabCycleResult> {
  const dbm = deps.db ?? defaultDb;
  const result: AutoGrabCycleResult = {
    due: 0, grabbed: 0, packs: 0, packEpisodes: 0, upgradeSearched: 0, upgradeGrabbed: 0,
    notFound: 0, notUpgrade: 0, failed: 0, deferred: 0,
  };
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownIso = new Date(nowMs - GRAB_INFLIGHT_HOURS * 3_600_000).toISOString();
  const preferPacks = config?.preferSeasonPacks !== false;
  const minMissing = config?.seasonPackMinMissing ?? 2;
  const upgrades = config?.upgradeUntilCutoff !== false;

  // Oversubscribe the fetch so rows dropped by the JS due check
  // still leave a full working set for this cycle.
  const candidates = dbm.listEpisodesDueForGrab(nowIso, cooldownIso, MAX_GRABS_PER_CYCLE * 2);
  const due = candidates.filter((e) => isDueForSearch(e, nowMs));
  const batch = due.slice(0, MAX_GRABS_PER_CYCLE);
  result.due = batch.length;
  result.deferred = due.length - batch.length;

  let grabberInstance: AutoGrabber | null = deps.grabber ?? null;
  const grabber = () => (grabberInstance ??= new GrabberService(config, downloadManager ?? undefined));
  const deadline = nowMs + CYCLE_BUDGET_MS;

  if (batch.length > 0) {
    debugLog(`Auto-grab: ${due.length} episode(s) due, processing ${batch.length} (cooldown ${GRAB_INFLIGHT_HOURS}h)`);
  }

  const packTried = new Set<string>();
  const packCovered = new Set<string>();

  for (let i = 0; i < batch.length; i++) {
    if (Date.now() > deadline) {
      result.deferred += batch.length - i;
      debugLog(`Auto-grab: cycle budget exhausted, deferring ${batch.length - i} episode(s) to next cycle`);
      break;
    }
    const ep = batch[i]!;
    const seasonKey = `${ep.show_id}::${ep.season_number}`;

    if (packCovered.has(`${seasonKey}::${ep.episode_number}`)) {
      result.packEpisodes++;
      continue;
    }

    // Season pack first, once per season per cycle; a miss falls through to
    // the per-episode search below for this and the season's other eps.
    if (preferPacks && !packTried.has(seasonKey)) {
      packTried.add(seasonKey);
      try {
        const show = dbm.getShow(ep.show_id);
        let mapped = false;
        try { mapped = dbm.isEpisodeMappingEnabled(ep.show_id); } catch {}
        const stats = dbm.getSeasonAirStats(ep.show_id, ep.season_number, nowIso);
        if (shouldTrySeasonPack({ season: ep.season_number, seriesType: show?.series_type ?? null, mapped, stats, minMissing, nowMs })) {
          const missing = dbm.listMissingEpisodeNumbers(ep.show_id, ep.season_number);
          const res = await grabber().grabSeasonPack(ep.show_id, ep.season_number, missing);
          if (res.success) {
            result.packs++;
            result.grabbed++;
            result.packEpisodes++;
            for (const n of missing) packCovered.add(`${seasonKey}::${n}`);
            debugLog(`Auto-grab: season pack for ${ep.show_title} S${ep.season_number} covers ${missing.length} missing episode(s)`);
            continue;
          }
        }
      } catch (err) {
        debugLog(`Auto-grab season-pack error for ${ep.show_title} S${ep.season_number}: ${err} - falling back to episode search`);
      }
    }

    try {
      const res = await grabber().grabBestRelease(ep.show_id, ep.season_number, ep.episode_number);
      if (res.success) {
        result.grabbed++;
        // Success is self-limiting for the next cycle two ways: the 12h
        // grabbed_at cooldown, and (once imported) episodes dropping out of
        // the due query via file_path.
      } else {
        result[classifyMiss(res.message)]++;
        // Searched, nothing grabbed -> back off this episode.
        try { dbm.recordEpisodeSearchMiss(ep.show_id, ep.season_number, ep.episode_number); } catch {}
      }
    } catch (err) {
      result.failed++;
      debugLog(`Auto-grab error for ${ep.show_title} S${ep.season_number}E${ep.episode_number}: ${err}`);
    }
  }

  // Lower-priority slice: a few cutoff-unmet upgrade searches, only with
  // budget left after the missing batch. Each miss backs the episode off
  // 6h -> 1d -> 3d -> 7d (core/cutoff.ts) and, after
  // config.upgradeGiveUpMisses of them, gives up on it; a new file resets
  // that, and once the upgraded file is at/above cutoff it leaves the pool.
  if (upgrades && Date.now() <= deadline) {
    let pool: CutoffUnmetEpisode[] = [];
    try {
      pool = deps.listUpgrades
        ? deps.listUpgrades(nowMs, cooldownIso)
        : listCutoffUnmetEpisodes(dbm, { nowMs, cooldownIso, applyBackoff: true, giveUp: giveUpPolicy(config) });
    } catch (err) {
      debugLog(`Auto-grab: cutoff-unmet lookup failed: ${err}`);
    }
    for (const up of pool.slice(0, MAX_UPGRADES_PER_CYCLE)) {
      if (Date.now() > deadline) break;
      result.upgradeSearched++;
      let res: GrabResult | null = null;
      try {
        res = await grabber().grabUpgradeRelease(up.showId, up.season, up.episode, up.existingScore);
      } catch (err) {
        debugLog(`Auto-grab upgrade error for ${up.showTitle} S${up.season}E${up.episode}: ${err}`);
      }
      if (res?.success) {
        result.upgradeGrabbed++;
      } else {
        // Only a search that ran and found nothing better counts toward
        // giving up; an indexer error / failed grab call just backs off.
        const counted = !!res && classifyMiss(res.message ?? '') !== 'failed';
        try { dbm.recordUpgradeSearchMiss(up.showId, up.season, up.episode, up.cutoffKey, counted); } catch {}
      }
    }
  }

  if (batch.length === 0 && result.upgradeSearched === 0) return result;

  const line = `Auto-grab cycle: ${result.due} due, ${result.grabbed} grabbed`
    + (result.packs ? ` (${result.packs} season pack(s) covering ${result.packEpisodes} due ep(s))` : '')
    + `, ${result.notFound} no releases, ${result.notUpgrade} not upgrades, ${result.failed} failed, ${result.deferred} deferred`
    + (result.upgradeSearched ? `, cutoff upgrades ${result.upgradeGrabbed}/${result.upgradeSearched} grabbed` : '');
  debugLog(line);
  dbm.logEvent({
    type: 'scheduler',
    entityType: 'task',
    entityId: 'auto-grab',
    message: line,
    metadata: { ...result },
  });

  return result;
}
