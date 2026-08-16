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