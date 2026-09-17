import { db, type Config } from '../db';
import { GrabberService } from './grabber_service';
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
 *   - past `expected_release_at` (the air-window forecast from air_window.ts;
 *     falls back to air_date + learned/default delay when the forecast has
 *     never run for the row),
 *   - no successful grab recorded in the last GRAB_INFLIGHT_HOURS — the
 *     re-grab guard. Without it, every cycle would re-submit the same release
 *     while the TorBox download is still in flight (file_path only lands when
 *     the import completes), or hammer a failed download endlessly. Failed
 *     *searches* intentionally have no cooldown: a release published after
 *     the last look should be caught by the next cycle.
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

export async function runAutoGrabCycle(
  config: Config,
  downloadManager?: DownloadManager | null,
): Promise<AutoGrabCycleResult> {
  const result: AutoGrabCycleResult = { due: 0, grabbed: 0, notFound: 0, notUpgrade: 0, failed: 0, deferred: 0 };
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownIso = new Date(nowMs - GRAB_INFLIGHT_HOURS * 3_600_000).toISOString();

  // Oversubscribe the fetch so rows dropped by the JS fallback-window check
  // still leave a full working set for this cycle.
  const candidates = db.listEpisodesDueForGrab(nowIso, cooldownIso, MAX_GRABS_PER_CYCLE * 2);
  const due = candidates.filter((e) =>
    e.expected_release_at ? true : isPastFallbackWindow(e.air_date, e.air_time, e.release_delay_minutes, nowMs),
  );
  const batch = due.slice(0, MAX_GRABS_PER_CYCLE);
  result.due = batch.length;
  result.deferred = due.length - batch.length;

  if (batch.length === 0) return result;

  debugLog(`Auto-grab: ${due.length} episode(s) due, processing ${batch.length} (cooldown ${GRAB_INFLIGHT_HOURS}h)`);

  const grabber = new GrabberService(config, downloadManager ?? undefined);
  const deadline = nowMs + CYCLE_BUDGET_MS;

  for (let i = 0; i < batch.length; i++) {
    if (Date.now() > deadline) {
      result.deferred += batch.length - i;
      debugLog(`Auto-grab: cycle budget exhausted, deferring ${batch.length - i} episode(s) to next cycle`);
      break;
    }
    const ep = batch[i]!;
    try {
      const res = await grabber.grabBestRelease(ep.show_id, ep.season_number, ep.episode_number);
      if (res.success) {
        result.grabbed++;
        // Success is self-limiting for the next cycle two ways: the 12h
        // grabbed_at cooldown, and (once imported) episodes dropping out of
        // the due query via file_path.
      } else if (res.message.includes('not an upgrade')) {
        result.notUpgrade++;
      } else if (res.message.includes('No releases found')) {
        result.notFound++;
      } else {
        result.failed++;
      }
    } catch (err) {
      result.failed++;
      debugLog(`Auto-grab error for ${ep.show_title} S${ep.season_number}E${ep.episode_number}: ${err}`);
    }
  }

  debugLog(
    `Auto-grab complete: ${result.grabbed} grabbed, ${result.notFound} no releases, ` +
    `${result.notUpgrade} not upgrades, ${result.failed} failed, ${result.deferred} deferred`,
  );
  db.logEvent({
    type: 'scheduler',
    entityType: 'task',
    entityId: 'auto-grab',
    message: `Auto-grab cycle: ${result.due} due, ${result.grabbed} grabbed, ${result.notFound} no releases, ${result.notUpgrade} not upgrades, ${result.failed} failed, ${result.deferred} deferred`,
    metadata: { ...result },
  });

  return result;
}
