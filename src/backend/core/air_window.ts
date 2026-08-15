import { db } from '../db';

/**
 * Air-window / expected-release forecasting.
 *
 * Air-window (airtime) tracking historically stored just the *expected air
 * date* (`episodes.air_date`), which is what the metadata provider says an
 * episode is scheduled to air - not when a release for it is actually likely
 * to become available. Releases routinely appear 30-60+ minutes after the
 * episode finishes airing, and that gap differs per show (scene groups vs
 * web-DL, anime simulcast delays, etc).
 *
 * This module:
 *   1. Builds a real "air datetime" from air_date (+ series-level air_time)
 *      so we have an exact timestamp rather than a bare date.
 *   2. Learns each show's typical release delay from the *observed* indexer
 *      publish dates recorded on grabbed_releases.publish_date.
 *   3. Computes and stores `episodes.expected_release_at` - the predicted
 *      (or observed, once a release lands) time a file should be grab-able,
 *      which the calendar/dashboard use instead of the raw air date.
 */

/** Default release delay (minutes after air) when a show has no learned
 *  history. 45 is the middle of the 30-60 min window that covers most
 *  standard TV and anime simulcast drops. */
export const DEFAULT_RELEASE_DELAY_MINUTES = 45;

/** Clamp learned delays to [5, 240] minutes - anything beyond that is a
 *  data mistake (bad air date, wrong publish date) not a real pattern. */
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 240;

/** Extract an ISO-ish air datetime from a bare date + optional time. */
export function buildAirDateTime(
  airDate: string | null | undefined,
  airTime: string | null | undefined,
): Date | null {
  if (!airDate) return null;
  const d = new Date(airDate);
  if (!Number.isNaN(d.getTime())) return d;

  // Date-only "YYYY-MM-DD" plus a known air time "HH:MM" -> local datetime.
  if (/^\d{4}-\d{2}-\d{2}$/.test(airDate) && airTime) {
    const local = new Date(`${airDate}T${airTime}`);
    if (!Number.isNaN(local.getTime())) return local;
  }
  return null;
}

/** Store the derived air time + expected release time on an episode. */
export function persistEpisodeAirWindow(
  showId: string,
  season: number,
  episode: number,
  airDate: string | null | undefined,
  airTime: string | null | undefined,
  learnedDelayMinutes: number | null,
): string | null {
  const airDt = buildAirDateTime(airDate, airTime);
  const delay = learnedDelayMinutes ?? DEFAULT_RELEASE_DELAY_MINUTES;
  const expectedReleaseAt = airDt ? new Date(airDt.getTime() + delay * 60 * 1000).toISOString() : null;

  db.updateEpisodeAirWindow(showId, season, episode, {
    airTime: airTime ?? null,
    expectedReleaseAt,
  });
  return expectedReleaseAt;
}

/**
 * Learn the show's typical release delay from observed gaze publish dates.
 * For each grabbed release with a publish_date, find the matching episode's
 * air datetime and diff them; persist the median as shows.release_delay_minutes.
 * Returns the learned value (or null when there isn't enough data).
 */
export function learnShowReleaseDelay(showId: string): number | null {
  const show = db.getShow(showId);
  if (!show) return null;

  const grabs = db.listGrabbedReleasesForShow(showId);
  const episodes = db.listAllEpisodes(showId);
  const epByKey = new Map<string, { air_date: string | null; air_time: string | null }>();
  for (const e of episodes) epByKey.set(`${e.season_number}:${e.episode_number}`, e);

  const delays: number[] = [];
  for (const grab of grabs) {
    if (!grab.publish_date || grab.season_number == null || grab.episode_number == null) continue;
    const ep = epByKey.get(`${grab.season_number}:${grab.episode_number}`);
    if (!ep) continue;
    const airDt = buildAirDateTime(ep.air_date, ep.air_time);
    if (!airDt) continue;
    const publish = new Date(grab.publish_date);
    if (Number.isNaN(publish.getTime())) continue;
    const diffMin = (publish.getTime() - airDt.getTime()) / 60000;
    if (diffMin < MIN_DELAY_MINUTES || diffMin > MAX_DELAY_MINUTES) continue;
    delays.push(Math.round(diffMin));
  }

  if (delays.length < 2) {
    // Not enough confidence - leave any existing learned value alone.
    return show.release_delay_minutes ?? null;
  }

  const sorted = [...delays].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;

  db.setShowReleaseDelay(showId, median);
  return median;
}

/**
 * Recompute + persist the air window for every episode of a show. Called
 * after a metadata sync (fresh air dates/times) and after each grab (new
 * learned delay). Episodes that already have an *observed* expected release
 * time (a file landed / a real publish date was seen) keep theirs; forecast
 * episodes get the predicted value so the UI always has a timestamp.
 */
export function reconcileShowAirWindows(showId: string, forceForecast = true) {
  const episodes = db.listAllEpisodes(showId);
  const learned = learnShowReleaseDelay(showId) ?? DEFAULT_RELEASE_DELAY_MINUTES;

  for (const ep of episodes) {
    // Existing observed values (from a real grab publish date or import) win
    // over a fresh forecast unless explicitly forcing.
    if (!forceForecast && ep.expected_release_at) continue;
    persistEpisodeAirWindow(
      showId,
      ep.season_number,
      ep.episode_number,
      ep.air_date,
      ep.air_time,
      learned,
    );
  }
}