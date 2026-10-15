import type { DatabaseManager } from './index';
import { GRAB_GATES, grabGateParams } from './grabs';

/** Auto-grab's gates (db/grabs.ts GRAB_GATES) minus the search backoff. */
const RSS_WHERE = (Object.keys(GRAB_GATES) as (keyof typeof GRAB_GATES)[])
  .filter(k => k !== 'outsideBackoff')
  .map(k => GRAB_GATES[k])
  .join('\n      AND ');

/**
 * RSS sync storage. Kept in its own module (not grabs.ts) so the RSS path
 * owns its eligibility query instead of inheriting search-side backoff
 * that auto-grab's listEpisodesDueForGrab may grow: a release that just
 * showed up in a feed should be grabbable regardless of how many searches
 * came back empty before.
 */

export interface RssCandidateEpisode {
  show_id: string;
  show_title: string;
  series_type: string | null;
  profile: string | null;
  library_type_id: string | null;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  air_time: string | null;
  expected_release_at: string | null;
  release_delay_minutes: number | null;
}

/**
 * Same eligibility as listEpisodesDueForGrab (tracked, auto search mode,
 * no file on disk, not a movie, release time passed, no grab recorded
 * since `grabCooldownIso` = the in-flight guard) - minus any search
 * cooldown. Caller still applies isDueForSearch() for the live air-time
 * check, exactly like auto-grab.
 */
export function listRssCandidateEpisodes(
  self: DatabaseManager,
  nowIso: string,
  grabCooldownIso: string,
  limit = 5000,
): RssCandidateEpisode[] {
  return self.db.query(`
    SELECT
      e.show_id,
      s.title                AS show_title,
      s.series_type,
      s.profile,
      s.library_type_id,
      e.season_number,
      e.episode_number,
      e.air_date,
      e.air_time,
      e.expected_release_at,
      s.release_delay_minutes
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    WHERE ${RSS_WHERE}
    ORDER BY COALESCE(e.expected_release_at, e.air_date) DESC
    LIMIT $limit
  `).all({ ...grabGateParams(nowIso, grabCooldownIso), $limit: limit }) as RssCandidateEpisode[];
}

/** Per-feed RSS position: newest pubDate seen + recent guids (tie-breaker / no-date feeds). */
export interface RssCursor {
  lastPubMs: number | null;
  seen: string[];
  updatedAt?: string;
}

/** Stored in `settings` (no migration needed) as one JSON blob keyed by feed key. */
export const RSS_CURSORS_SETTING = 'rssSync.cursors';

export function loadRssCursors(self: DatabaseManager): Record<string, RssCursor> {
  try {
    const raw = self.getSetting(RSS_CURSORS_SETTING);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRssCursors(self: DatabaseManager, cursors: Record<string, RssCursor>) {
  self.setSetting(RSS_CURSORS_SETTING, cursors);
}
