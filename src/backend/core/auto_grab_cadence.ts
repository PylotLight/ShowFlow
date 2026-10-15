/**
 * Auto-grab backfill cadence.
 *
 * rss-sync (core/rss_sync.ts) already catches new releases every 15 min for
 * one request per feed. While it's healthy, auto-grab's per-episode search
 * sweep is only a backfill (releases that scrolled off a feed, old
 * episodes), so it can run every 60 min instead of 15 — far fewer indexer
 * searches. The moment RSS is disabled, hasn't run recently, has no feeds,
 * or any feed failed, auto-grab drops straight back to its normal cadence.
 *
 * The scheduler still ticks auto-grab at its configured interval; the task
 * action asks shouldRunAutoGrab() and skips a cycle when it's too soon.
 * Manual "run now" always runs.
 */

export const RELAXED_AUTO_GRAB_MINUTES = 60;

export interface RssOutcome {
  at: number;
  feeds: number;
  feedErrors: number;
  /** The cycle threw before finishing. */
  threw: boolean;
}

let lastRss: RssOutcome | null = null;
let lastAutoGrabRun: number | null = null;

export function recordRssOutcome(o: RssOutcome) {
  lastRss = o;
}

export function recordAutoGrabRun(at = Date.now()) {
  lastAutoGrabRun = at;
}

/** Test hook. */
export function resetAutoGrabCadence() {
  lastRss = null;
  lastAutoGrabRun = null;
}

export interface CadenceInput {
  now: number;
  rssEnabled: boolean;
  rssIntervalMinutes: number;
  rss: RssOutcome | null;
}

/**
 * RSS counts as healthy when it's enabled, its last cycle finished within
 * two of its intervals (+5 min slack), it actually read at least one feed,
 * and no feed failed.
 */
export function isRssHealthy(i: CadenceInput): boolean {
  if (!i.rssEnabled || !i.rss) return false;
  if (i.rss.threw || i.rss.feeds === 0 || i.rss.feedErrors > 0) return false;
  const maxAgeMs = (Math.max(1, i.rssIntervalMinutes) * 2 + 5) * 60_000;
  return i.now - i.rss.at <= maxAgeMs;
}

/** Effective minutes between auto-grab sweeps. */
export function autoGrabIntervalMinutes(i: CadenceInput & { configuredMinutes: number }): number {
  return isRssHealthy(i) ? Math.max(i.configuredMinutes, RELAXED_AUTO_GRAB_MINUTES) : i.configuredMinutes;
}

/**
 * Should this scheduled tick actually sweep? Always yes for manual runs,
 * the first run since boot, or when RSS isn't healthy. A 1-minute grace
 * absorbs scheduler jitter so a 60 min cadence on a 15 min tick doesn't
 * slip to 75.
 */
export function shouldRunAutoGrab(i: CadenceInput & {
  configuredMinutes: number;
  lastRunAt: number | null;
  manual?: boolean;
}): { run: boolean; intervalMinutes: number } {
  const intervalMinutes = autoGrabIntervalMinutes(i);
  if (i.manual || i.lastRunAt == null || intervalMinutes <= i.configuredMinutes) {
    return { run: true, intervalMinutes };
  }
  const due = i.lastRunAt + (intervalMinutes - 1) * 60_000;
  return { run: i.now >= due, intervalMinutes };
}

/** Current state, for the scheduler action. */
export function cadenceState() {
  return { lastRss, lastAutoGrabRun };
}
