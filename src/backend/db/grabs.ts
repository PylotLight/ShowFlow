import { and, eq, desc, sql, gte } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';
import { resolveStatusTargets, setEpisodeStatus } from './episode_status';

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

  // Persisted pipeline status: the grabbed episode(s) are now downloading.
  // Here rather than at each caller so auto-grab, RSS, manual and
  // interactive grabs all land the same transition.
  try {
    const nowIso = new Date().toISOString();
    for (const t of resolveStatusTargets(self, input.showId, input.season, input.episode)) {
      setEpisodeStatus(self, t, {
        state: 'grabbed_downloading', blocker: null, meta: null,
        detail: `Sent "${input.releaseTitle}" to the download client`,
        releaseTitle: input.releaseTitle,
      }, nowIso);
    }
  } catch { /* status is best-effort; never fail a grab over it */ }

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
 * True when the episode has never been searched, or its release window moved
 * past the last search (air date changed later) - backoff doesn't apply.
 */
const SEARCH_WINDOW_FRESH =
  `(e.last_searched_at IS NULL OR COALESCE(e.expected_release_at, e.air_date, '') > e.last_searched_at)`;

/**
 * The auto-grab eligibility gates, one SQL predicate each, over `episodes e
 * JOIN shows s`. This is the single source of truth: listEpisodesDueForGrab
 * ANDs all of them, listRssCandidateEpisodes ANDs all but `outsideBackoff`,
 * and core/pipeline/explain.ts selects each one as a column so the Pipeline
 * can say *which* gate is holding an episode back - no parallel copy of the
 * rules to drift. Bind with grabGateParams().
 */
export const GRAB_GATES = {
  tracked: `e.is_tracked = 1`,
  autoMode: `(e.search_mode IS NULL OR e.search_mode = 'auto')`,
  missing: `(e.file_path IS NULL OR e.file_path = '')`,
  notMovie: `COALESCE(s.series_type, 'standard') != 'movie'`,
  released: `(
        (e.expected_release_at IS NOT NULL AND e.expected_release_at <= $now)
        OR (e.expected_release_at IS NULL AND e.air_date IS NOT NULL AND e.air_date != '' AND e.air_date <= $now)
      )`,
  notInflight: `NOT EXISTS (
        SELECT 1 FROM grabbed_releases g
        WHERE g.show_id = e.show_id
          AND g.season_number = e.season_number
          AND (g.episode_number = e.episode_number OR g.episode_number IS NULL)
          AND replace(g.grabbed_at, ' ', 'T') >= $cooldown
          AND g.status != 'failed'
      )`,
  outsideBackoff: `(
        ${SEARCH_WINDOW_FRESH}
        OR e.last_searched_at <= CASE
          WHEN e.search_attempts <= 1 THEN $b1
          WHEN e.search_attempts = 2 THEN $b2
          WHEN e.search_attempts = 3 THEN $b3
          ELSE $b4
        END
      )`,
} as const;

export type GrabGate = keyof typeof GRAB_GATES;

/** All gates ANDed: the auto-grab due set (before the live isDueForSearch check). */
export const DUE_FOR_GRAB_WHERE = Object.values(GRAB_GATES).join('\n      AND ');

/** Named bind params for GRAB_GATES ($now, $cooldown, $b1..$b4 backoff cutoffs). */
export function grabGateParams(nowIso: string, grabCooldownIso: string): Record<string, string> {
  const nowMs = new Date(nowIso).getTime();
  const [b1, b2, b3, b4] = SEARCH_BACKOFF_MINUTES.map(m => new Date(nowMs - m * 60_000).toISOString());
  return { $now: nowIso, $cooldown: grabCooldownIso, $b1: b1!, $b2: b2!, $b3: b3!, $b4: b4! };
}

/** When the backoff after `attempts` consecutive misses lapses (null = no backoff). */
export function searchBackoffUntil(lastSearchedAt: string | null, attempts: number): string | null {
  if (!lastSearchedAt || attempts <= 0) return null;
  const idx = Math.min(Math.max(attempts, 1), SEARCH_BACKOFF_MINUTES.length) - 1;
  const t = new Date(lastSearchedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + SEARCH_BACKOFF_MINUTES[idx]! * 60_000).toISOString();
}

/**
 * Episodes the auto-grabber should consider this cycle: tracked, in
 * auto-search mode, missing from disk, past their expected release time,
 * without an in-flight grab already recorded within `grabCooldownIso` (an
 * episode grab, or a season-pack grab for its season - episode_number
 * NULL), and
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
    WHERE ${DUE_FOR_GRAB_WHERE}
    ORDER BY
      CASE WHEN ${SEARCH_WINDOW_FRESH} THEN 0 ELSE 1 END,
      CASE WHEN ${SEARCH_WINDOW_FRESH} THEN COALESCE(e.expected_release_at, e.air_date) END DESC,
      e.last_searched_at ASC
    LIMIT $limit
  `).all({ ...grabGateParams(nowIso, grabCooldownIso), $limit: limit }) as EpisodeDueForGrab[];
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
  // Blocker/detail are kept: the grabber's search events already wrote the
  // specific reason (no results vs rejected by profile) for this miss.
  try { setEpisodeStatus(self, { showId, season, episode }, { state: 'not_found' }, nowIso); } catch {}
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

// ---------- cutoff upgrades + season packs ----------

export interface EpisodeWithFileRow {
  show_id: string;
  show_title: string;
  series_type: string | null;
  profile: string | null;
  library_type_id: string | null;
  season_number: number;
  episode_number: number;
  file_path: string;
  last_searched_at: string | null;
  search_attempts: number;
}

/**
 * Tracked, auto-mode episodes that HAVE a file on disk and no in-flight
 * grab since `grabCooldownIso` - the raw pool core/cutoff.ts filters down to
 * "cutoff unmet" (the quality check needs the quality engine, so it runs in
 * JS). Upgrade-search backoff is applied by the caller too.
 */
export function listEpisodesWithFiles(
  self: DatabaseManager,
  grabCooldownIso: string,
): EpisodeWithFileRow[] {
  return self.db.query(`
    SELECT
      e.show_id,
      s.title AS show_title,
      s.series_type,
      s.profile,
      s.library_type_id,
      e.season_number,
      e.episode_number,
      e.file_path,
      e.last_searched_at,
      e.search_attempts
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    WHERE e.is_tracked = 1
      AND (e.search_mode IS NULL OR e.search_mode = 'auto')
      AND e.file_path IS NOT NULL AND e.file_path != ''
      AND COALESCE(s.series_type, 'standard') != 'movie'
      AND NOT EXISTS (
        SELECT 1 FROM grabbed_releases g
        WHERE g.show_id = e.show_id
          AND g.season_number = e.season_number
          AND (g.episode_number = e.episode_number OR g.episode_number IS NULL)
          AND replace(g.grabbed_at, ' ', 'T') >= ?
          AND g.status != 'failed'
      )
  `).all(grabCooldownIso) as EpisodeWithFileRow[];
}

export interface SeasonAirStats {
  /** Episode rows in the season. */
  total: number;
  /** Rows with no air date or an air date after `nowIso`. */
  unaired: number;
  /** Latest air_date in the season (null when none). */
  lastAirDate: string | null;
  /** Tracked rows with a file on disk. */
  trackedWithFile: number;
  /** Tracked, auto-mode rows with no file - what a season pack would fill. */
  missingTracked: number;
  /** Highest season number of the show that has any episode row. */
  maxSeason: number;
}

export function getSeasonAirStats(
  self: DatabaseManager,
  showId: string,
  season: number,
  nowIso: string,
): SeasonAirStats {
  const row = self.db.query(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN air_date IS NULL OR air_date = '' OR air_date > ? THEN 1 ELSE 0 END), 0) AS unaired,
      MAX(NULLIF(air_date, '')) AS lastAirDate,
      COALESCE(SUM(CASE WHEN is_tracked = 1 AND file_path IS NOT NULL AND file_path != '' THEN 1 ELSE 0 END), 0) AS trackedWithFile,
      COALESCE(SUM(CASE WHEN is_tracked = 1 AND (search_mode IS NULL OR search_mode = 'auto')
                         AND (file_path IS NULL OR file_path = '') THEN 1 ELSE 0 END), 0) AS missingTracked,
      (SELECT COALESCE(MAX(season_number), 0) FROM episodes WHERE show_id = ?) AS maxSeason
    FROM episodes
    WHERE show_id = ? AND season_number = ?
  `).get(nowIso, showId, showId, season) as SeasonAirStats;
  return row;
}

/** Tracked, auto-mode, fileless episode numbers of one season. */
export function listMissingEpisodeNumbers(self: DatabaseManager, showId: string, season: number): number[] {
  const rows = self.db.query(`
    SELECT episode_number FROM episodes
    WHERE show_id = ? AND season_number = ? AND is_tracked = 1
      AND (search_mode IS NULL OR search_mode = 'auto')
      AND (file_path IS NULL OR file_path = '')
    ORDER BY episode_number
  `).all(showId, season) as { episode_number: number }[];
  return rows.map(r => r.episode_number);
}

/** Normalized titles already grabbed for one episode (or its season as a pack). */
export function listGrabbedTitlesForEpisode(self: DatabaseManager, showId: string, season: number, episode: number): Set<string> {
  const rows = self.db.query(`
    SELECT normalized_title FROM grabbed_releases
    WHERE show_id = ? AND season_number = ? AND (episode_number = ? OR episode_number IS NULL)
  `).all(showId, season, episode) as { normalized_title: string }[];
  return new Set(rows.map(r => r.normalized_title));
}
