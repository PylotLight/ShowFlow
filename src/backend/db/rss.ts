import type { DatabaseManager } from './index';

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
    WHERE e.is_tracked = 1
      AND (e.search_mode IS NULL OR e.search_mode = 'auto')
      AND (e.file_path IS NULL OR e.file_path = '')
      AND COALESCE(s.series_type, 'standard') != 'movie'
      AND (
        (e.expected_release_at IS NOT NULL AND e.expected_release_at <= ?)
        OR (e.expected_release_at IS NULL AND e.air_date IS NOT NULL AND e.air_date != '' AND e.air_date <= ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM grabbed_releases g
        WHERE g.show_id = e.show_id
          AND g.season_number = e.season_number
          AND g.episode_number = e.episode_number
          AND replace(g.grabbed_at, ' ', 'T') >= ?
      )
    ORDER BY COALESCE(e.expected_release_at, e.air_date) DESC
    LIMIT ?
  `).all(nowIso, nowIso, grabCooldownIso, limit) as RssCandidateEpisode[];
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
