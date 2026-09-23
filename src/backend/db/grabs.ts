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
}

/** Record that `releaseTitle` was grabbed for showId/season/episode. */
export function recordGrabbedRelease(self: DatabaseManager, input: {
  showId: string;
  season?: number | null;
  episode?: number | null;
  releaseTitle: string;
  indexerName?: string | null;
  publishDate?: string | null;
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
      // Explicit ISO (same rationale as logPipelineEvent in pipeline.ts): the
      // column default is `datetime('now')` -> "YYYY-MM-DD HH:MM:SS", which
      // sorts *below* an ISO "YYYY-MM-DDTHH:MM:SSZ" cutoff on the same day
      // and silently breaks the cooldown windows in listEpisodesDueForGrab /
      // findGrabbedReleaseFor*.
      grabbed_at: new Date().toISOString(),
    })
    .run();

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
 * Episodes the auto-grabber should consider this cycle: tracked, in
 * auto-search mode, missing from disk, past their expected release time,
 * and without an in-flight grab already recorded within `grabCooldownIso`.
 *
 * The deadline check trusts `expected_release_at` when the air-window
 * forecast has run for the episode (the normal case after any sync); rows
 * without it are returned only when their raw air_date is already past,
 * and the caller re-applies the air_date(+air_time)+delay math with the
 * same formula as air_window.ts before treating them as due — so a future
 * episode with no forecast yet can never slip into a search cycle.
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
      )
    ORDER BY COALESCE(e.expected_release_at, e.air_date) DESC
    LIMIT ?
  `).all(nowIso, nowIso, grabCooldownIso, limit) as EpisodeDueForGrab[];
}