import { and, eq, desc, sql, gte } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';

/** How many grabbed releases to keep in the lookup table (FIFO). */
const GRAB_RETENTION_LIMIT = 500;

export function normalizeReleaseTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export interface GrabbedReleaseRow {
  id: number;
  show_id: string;
  season_number: number | null;
  episode_number: number | null;
  release_title: string;
  normalized_title: string;
  indexer_name: string | null;
  publish_date: string | null;
  grabbed_at: string | null;
  status: GrabStatus;
  info_hash: string | null;
  release_key: string | null;
  failure_reason: string | null;
  failed_at: string | null;
}

export const GRAB_STATUSES = ['grabbed', 'downloading', 'completed', 'imported', 'failed'] as const;
export type GrabStatus = typeof GRAB_STATUSES[number];

/** Lowercased btih hash, or null. Accepts a bare hash or a magnet URI. */
export function normalizeInfoHash(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).match(/btih:([a-z0-9]+)/i);
  const h = (m ? m[1]! : String(input)).trim().toLowerCase();
  return /^[a-z0-9]{32,40}$/.test(h) ? h : null;
}

/** Record that `releaseTitle` was grabbed for showId/season/episode. */
export function recordGrabbedRelease(self: DatabaseManager, input: {
  showId: string;
  season?: number | null;
  episode?: number | null;
  releaseTitle: string;
  indexerName?: string | null;
  publishDate?: string | null;
  /** Info hash or magnet URI (normalized to a lowercase hash). */
  infoHash?: string | null;
  /** `indexer::guid` style identity for hash-less releases. */
  releaseKey?: string | null;
}) {
  const normalized = normalizeReleaseTitle(input.releaseTitle);
  if (!normalized) return;
  self.drizz
    .insert(schema.grabbedReleases)
    .values({
      show_id: input.showId,
      season_number: input.season ?? null,
      episode_number: input.episode ?? null,
      release_title: input.releaseTitle,
      normalized_title: normalized,
      indexer_name: input.indexerName ?? null,
      publish_date: input.publishDate ?? null,
      info_hash: normalizeInfoHash(input.infoHash),
      release_key: input.releaseKey ?? null,
      status: 'grabbed',
      // Explicit ISO (same rationale as logPipelineEvent in pipeline.ts): the
      // column default is `datetime('now')` -> "YYYY-MM-DD HH:MM:SS", which
      // sorts *below* an ISO "YYYY-MM-DDTHH:MM:SSZ" cutoff on the same day
      // and silently breaks the cooldown windows in listEpisodesDueForGrab /
      // findGrabbedReleaseFor*.
      grabbed_at: new Date().toISOString(),
    })
    .run();

  // A grab ends the search-miss streak: clear the backoff so, if the
  // download dies and the in-flight cooldown lapses, the episode is retried
  // promptly instead of waiting out a 24h backoff. Season packs reset the
  // whole season.
  if (input.season != null) {
    self.db.query(`
      UPDATE episodes SET last_searched_at = NULL, search_attempts = 0
      WHERE show_id = ? AND season_number = ? AND (? IS NULL OR episode_number = ?)
        AND (last_searched_at IS NOT NULL OR search_attempts != 0)
    `).run(input.showId, input.season, input.episode ?? null, input.episode ?? null);
  }

  // Retain only the most recent GRAB_RETENTION_LIMIT rows so the hint
  // lookup below never scans a stale, unbounded history.
  const rows = self.drizz
    .select({ id: schema.grabbedReleases.id })
    .from(schema.grabbedReleases)
    .orderBy(desc(schema.grabbedReleases.id))
    .limit(GRAB_RETENTION_LIMIT)
    .all() as { id: number }[];
  if (rows.length < GRAB_RETENTION_LIMIT) return;
  const keep = new Set(rows.map(r => r.id));
  self.drizz
    .delete(schema.grabbedReleases)
    .where(sql`${schema.grabbedReleases.id} NOT IN (${sql.join(
      [...keep].map(id => sql`${id}`),
      sql`, `,
    )})`)
    .run();
}

/**
 * Find the most recent grab for a given season/episode pair. When a file
 * lands in the watch folder with an unresolvable/generic name but the
 * filename/parsed title still exposes a season+episode number, this lets
 * the import step pin the exact series it was grabbed for.
 */
export function findGrabbedReleaseForEpisode(
  self: DatabaseManager,
  season: number,
  episode: number,
  withinDays = 60,
): GrabbedReleaseRow | null {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = self.drizz
    .select()
    .from(schema.grabbedReleases)
    .where(and(
      eq(schema.grabbedReleases.season_number, season),
      eq(schema.grabbedReleases.episode_number, episode),
      gte(schema.grabbedReleases.grabbed_at, cutoff),
    ))
    .orderBy(desc(schema.grabbedReleases.id))
    .limit(1)
    .all() as GrabbedReleaseRow[];
  return rows[0] ?? null;
}

/** Most recent grab for a show, if any (used as a title hint too). */
export function findMostRecentGrabForShow(
  self: DatabaseManager,
  showId: string,
  withinDays?: number,
): GrabbedReleaseRow | null {
  const cutoff = new Date(Date.now() - (withinDays ?? 60) * 24 * 60 * 60 * 1000).toISOString();
  const rows = self.drizz
    .select()
    .from(schema.grabbedReleases)
    .where(and(
      eq(schema.grabbedReleases.show_id, showId),
      gte(schema.grabbedReleases.grabbed_at, cutoff),
    ))
    .orderBy(desc(schema.grabbedReleases.id))
    .limit(5)
    .all() as GrabbedReleaseRow[];
  return rows[0] ?? null;
}

/**
 * The most recent grab for a specific episode *of a show*. Stricter than
 * findGrabbedReleaseForEpisode (which is show-agnostic and serves as an
 * import hint); this is used to attach provenance when a landed file maps
 * back to the show it was grabbed for.
 */
export function findGrabbedReleaseForShowEpisode(
  self: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
  withinDays = 30,
): GrabbedReleaseRow | null {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = self.drizz
    .select()
    .from(schema.grabbedReleases)
    .where(and(
      eq(schema.grabbedReleases.show_id, showId),
      eq(schema.grabbedReleases.season_number, season),
      eq(schema.grabbedReleases.episode_number, episode),
      gte(schema.grabbedReleases.grabbed_at, cutoff),
    ))
    .orderBy(desc(schema.grabbedReleases.id))
    .limit(1)
    .all() as GrabbedReleaseRow[];
  return rows[0] ?? null;
}

/** All grabs recorded for a show (used to learn the show's release delay). */
export function listGrabbedReleasesForShow(
  self: DatabaseManager,
  showId: string,
  limit = 200,
): GrabbedReleaseRow[] {
  return self.drizz
    .select()
    .from(schema.grabbedReleases)
    .where(eq(schema.grabbedReleases.show_id, showId))
    .orderBy(desc(schema.grabbedReleases.id))
    .limit(limit)
    .all() as GrabbedReleaseRow[];
}

export interface EpisodeDueForGrab {
  show_id: string;
  show_title: string;
  season_number: number;
  episode_number: number;
  air_date: string | null;
  air_time: string | null;
  expected_release_at: string | null;
  release_delay_minutes: number | null;
}

/**
 * Backoff ladder for scheduled searches that came back without a grab,
 * indexed by consecutive misses (1st miss -> 15m, 2nd -> 1h, 3rd -> 6h,
 * then capped at 24h). Fresh episodes still get searched every cycle until
 * the first miss; long-missing ones stop eating the per-cycle budget.
 */
export const SEARCH_BACKOFF_MINUTES = [15, 60, 360, 1440] as const;

/**
 * Episodes the auto-grabber should consider this cycle: tracked, in
 * auto-search mode, missing from disk, past their expected release time,
 * without an in-flight grab already recorded within `grabCooldownIso`, and
 * outside their search backoff (see SEARCH_BACKOFF_MINUTES).
 *
 * The deadline check trusts `expected_release_at` when the air-window
 * forecast has run for the episode (the normal case after any sync); rows
 * without it are returned only when their raw air_date is already past,
 * and the caller re-applies the air_date(+air_time)+delay math with the
 * same formula as air_window.ts before treating them as due — so a future
 * episode with no forecast yet can never slip into a search cycle.
 *
 * Backoff is ignored when the episode's release window is newer than the
 * last search (air date moved later after we searched), so a corrected
 * date gets searched right away.
 *
 * Ordering: never-searched (or window-moved) episodes first, newest release
 * first — that's a freshly aired ep; then previously-missed episodes by
 * oldest search first, so a long tail of old missing eps rotates through
 * the budget instead of the same 50 starving everything behind them.
 *
 * `replace(grabbed_at,' ','T')` normalizes legacy `datetime('now')`-default
 * rows ("YYYY-MM-DD HH:MM:SS") so they compare correctly against the ISO
 * cooldown cutoff (new writes are explicit ISO - see recordGrabbedRelease).
 */
export function listEpisodesDueForGrab(
  self: DatabaseManager,
  nowIso: string,
  grabCooldownIso: string,
  limit: number,
): EpisodeDueForGrab[] {
  const nowMs = new Date(nowIso).getTime();
  const [b1, b2, b3, b4] = SEARCH_BACKOFF_MINUTES.map(m => new Date(nowMs - m * 60_000).toISOString());
  return self.db.query(`
    SELECT
      e.show_id,
      s.title                AS show_title,
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
          AND g.status != 'failed'
      )
      AND (
        e.last_searched_at IS NULL
        OR COALESCE(e.expected_release_at, e.air_date, '') > e.last_searched_at
        OR e.last_searched_at <= CASE
          WHEN e.search_attempts <= 1 THEN ?
          WHEN e.search_attempts = 2 THEN ?
          WHEN e.search_attempts = 3 THEN ?
          ELSE ?
        END
      )
    ORDER BY
      CASE WHEN e.last_searched_at IS NULL OR COALESCE(e.expected_release_at, e.air_date, '') > e.last_searched_at THEN 0 ELSE 1 END,
      CASE WHEN e.last_searched_at IS NULL OR COALESCE(e.expected_release_at, e.air_date, '') > e.last_searched_at THEN COALESCE(e.expected_release_at, e.air_date) END DESC,
      e.last_searched_at ASC
    LIMIT ?
  `).all(nowIso, nowIso, grabCooldownIso, b1!, b2!, b3!, b4!, limit) as EpisodeDueForGrab[];
}

/**
 * Record a scheduled search that ended without a grab (no releases, not an
 * upgrade, grab failed) so listEpisodesDueForGrab backs it off. A miss after
 * the release window moved restarts the streak at 1.
 */
export function recordEpisodeSearchMiss(
  self: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
  nowIso = new Date().toISOString(),
) {
  self.db.query(`
    UPDATE episodes SET
      search_attempts = CASE
        WHEN last_searched_at IS NULL OR COALESCE(expected_release_at, air_date, '') > last_searched_at THEN 1
        ELSE search_attempts + 1
      END,
      last_searched_at = ?
    WHERE show_id = ? AND season_number = ? AND episode_number = ?
  `).run(nowIso, showId, season, episode);
}

export function getGrab(self: DatabaseManager, id: number): GrabbedReleaseRow | null {
  return (self.drizz.select().from(schema.grabbedReleases)
    .where(eq(schema.grabbedReleases.id, id)).get() as GrabbedReleaseRow | undefined) ?? null;
}

/**
 * Move a grab forward in its lifecycle. Never resurrects a failed grab and
 * never moves an imported one backwards (a late "completed" after import).
 */
export function markGrabStatus(self: DatabaseManager, id: number, status: Exclude<GrabStatus, 'failed'>) {
  const order: Record<string, number> = { grabbed: 0, downloading: 1, completed: 2, imported: 3 };
  self.db.query(`
    UPDATE grabbed_releases SET status = ?
    WHERE id = ? AND status != 'failed'
      AND CASE status WHEN 'grabbed' THEN 0 WHEN 'downloading' THEN 1 WHEN 'completed' THEN 2 WHEN 'imported' THEN 3 ELSE 0 END < ?
  `).run(status, id, order[status]!);
}

/**
 * Grabs still in flight (not imported/failed) for a release, matched by info
 * hash when known, else by normalized title. A pack/multi-ep grab has one row
 * per episode; all of them are returned. Used by the TorBox waiter, which
 * only knows the release it submitted.
 */
export function findOpenGrabsForRelease(
  self: DatabaseManager,
  release: { title: string; infoHash?: string | null },
  withinDays = 7,
): GrabbedReleaseRow[] {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  const hash = normalizeInfoHash(release.infoHash);
  const norm = normalizeReleaseTitle(release.title);
  return self.db.query(`
    SELECT * FROM grabbed_releases
    WHERE status IN ('grabbed', 'downloading', 'completed')
      AND replace(grabbed_at, ' ', 'T') >= ?
      AND ((? IS NOT NULL AND info_hash = ?) OR normalized_title = ?)
    ORDER BY id DESC
  `).all(cutoff, hash, hash, norm) as GrabbedReleaseRow[];
}

/** Mark a grab failed (frees the in-flight cooldown for its episode). */
export function markGrabFailed(self: DatabaseManager, id: number, reason: string, nowIso = new Date().toISOString()) {
  self.db.query(`
    UPDATE grabbed_releases SET status = 'failed', failure_reason = ?, failed_at = ?
    WHERE id = ?
  `).run(reason.slice(0, 500), nowIso, id);
}

export interface GrabListRow extends GrabbedReleaseRow {
  show_title: string | null;
}

/** Recent grabs with show titles, newest first (History / fail action). */
export function listRecentGrabs(self: DatabaseManager, limit = 100): GrabListRow[] {
  return self.db.query(`
    SELECT g.*, s.title AS show_title
    FROM grabbed_releases g LEFT JOIN shows s ON s.id = g.show_id
    ORDER BY g.id DESC LIMIT ?
  `).all(Math.max(1, Math.min(500, limit))) as GrabListRow[];
}
