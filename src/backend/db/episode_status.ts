import type { DatabaseManager } from './index';
import type { LogPipelineEventInput } from './pipeline';
import { normalizeReleaseTitle } from './grabs';

/**
 * Persisted per-episode pipeline status (episode_status table) - the last
 * known outcome of the grab -> download -> import flow, upserted at each
 * transition. See schema.ts episodeStatus for why it exists; the live
 * auto-grab gates are evaluated on read in core/pipeline/explain.ts.
 */

export type PersistedState = 'grabbed_downloading' | 'importing' | 'stuck' | 'not_found' | 'done';

export interface EpisodeStatusRow {
  show_id: string;
  season_number: number;
  episode_number: number;
  state: PersistedState;
  blocker: string | null;
  detail: string | null;
  release_title: string | null;
  meta_json: string | null;
  since: string;
  updated_at: string;
}

export interface StatusTarget {
  showId: string;
  season: number;
  episode: number;
}

export interface StatusUpdate {
  state: PersistedState;
  /** undefined = keep the current value; null = clear it. */
  blocker?: string | null;
  detail?: string | null;
  releaseTitle?: string | null;
  meta?: unknown;
}

/** Movies key their status on the same S0E0 sentinel as episode_files. */
export const MOVIE_STATUS_SEASON = 0;
export const MOVIE_STATUS_EPISODE = 0;

/**
 * Upsert one status row. `since` only moves when the state changes, so the
 * UI can say how long something has been stuck. Fields left undefined keep
 * their current value (a quiet search miss keeps the last miss's reason).
 */
export function setEpisodeStatus(
  self: DatabaseManager,
  target: StatusTarget,
  update: StatusUpdate,
  nowIso = new Date().toISOString(),
) {
  const keep = (v: unknown) => (v === undefined ? 1 : 0);
  const val = (v: unknown) => (v === undefined ? null : v);
  const meta = update.meta === undefined ? undefined : update.meta === null ? null : JSON.stringify(update.meta);
  self.db.query(`
    INSERT INTO episode_status (show_id, season_number, episode_number, state, blocker, detail, release_title, meta_json, since, updated_at)
    VALUES ($show, $season, $episode, $state, $blocker, $detail, $release, $meta, $now, $now)
    ON CONFLICT (show_id, season_number, episode_number) DO UPDATE SET
      since         = CASE WHEN episode_status.state = excluded.state THEN episode_status.since ELSE excluded.since END,
      state         = excluded.state,
      blocker       = CASE WHEN $keepBlocker = 1 THEN episode_status.blocker ELSE excluded.blocker END,
      detail        = CASE WHEN $keepDetail = 1 THEN episode_status.detail ELSE excluded.detail END,
      release_title = CASE WHEN $keepRelease = 1 THEN episode_status.release_title ELSE excluded.release_title END,
      meta_json     = CASE WHEN $keepMeta = 1 THEN episode_status.meta_json ELSE excluded.meta_json END,
      updated_at    = excluded.updated_at
  `).run({
    $show: target.showId,
    $season: target.season,
    $episode: target.episode,
    $state: update.state,
    $blocker: val(update.blocker) as string | null,
    $detail: val(update.detail) as string | null,
    $release: val(update.releaseTitle) as string | null,
    $meta: val(meta) as string | null,
    $now: nowIso,
    $keepBlocker: keep(update.blocker),
    $keepDetail: keep(update.detail),
    $keepRelease: keep(update.releaseTitle),
    $keepMeta: keep(meta),
  });
}

export function getEpisodeStatus(self: DatabaseManager, target: StatusTarget): EpisodeStatusRow | null {
  return (self.db.query(`
    SELECT * FROM episode_status WHERE show_id = ? AND season_number = ? AND episode_number = ?
  `).get(target.showId, target.season, target.episode) as EpisodeStatusRow | null) ?? null;
}

/**
 * Resolve the episodes an event/grab is about. Episode-level -> that row.
 * Season-level (episode null, season pack) -> every still-missing episode
 * of the season, or all of them for `done`. Show-level (both null) -> the
 * movie's S0E0 row, only for movie shows; show-level rows of a series
 * carry no per-episode meaning and are ignored.
 */
export function resolveStatusTargets(
  self: DatabaseManager,
  showId: string,
  season: number | null | undefined,
  episode: number | null | undefined,
  opts: { includeOnDisk?: boolean } = {},
): StatusTarget[] {
  if (season != null && episode != null) return [{ showId, season, episode }];
  if (season != null) {
    const rows = self.db.query(`
      SELECT episode_number FROM episodes
      WHERE show_id = ? AND season_number = ?
        AND (? = 1 OR file_path IS NULL OR file_path = '')
    `).all(showId, season, opts.includeOnDisk ? 1 : 0) as { episode_number: number }[];
    return rows.map(r => ({ showId, season, episode: r.episode_number }));
  }
  const show = self.db.query(`SELECT series_type FROM shows WHERE id = ?`).get(showId) as { series_type: string | null } | null;
  if (show?.series_type === 'movie') return [{ showId, season: MOVIE_STATUS_SEASON, episode: MOVIE_STATUS_EPISODE }];
  return [];
}

function applyToTargets(self: DatabaseManager, targets: StatusTarget[], update: StatusUpdate, nowIso: string) {
  if (targets.length === 0) return;
  const tx = self.db.transaction(() => {
    for (const t of targets) setEpisodeStatus(self, t, update, nowIso);
  });
  tx();
}

/** Seconds within which a no_qualifying_releases row belongs to the search_completed just before it. */
const SAME_SEARCH_WINDOW_MS = 60_000;

/**
 * Translate a pipeline event into a status transition. Called from
 * logPipelineEvent, so every flow that already logs (grabber, rss, blackhole
 * import, manual search) updates the status with no extra call sites.
 * Unknown / purely informational events are ignored.
 */
export function applyPipelineEventToStatus(self: DatabaseManager, event: LogPipelineEventInput, nowIso = new Date().toISOString()) {
  const type = event.eventType;
  const targetsFor = (opts?: { includeOnDisk?: boolean }) =>
    resolveStatusTargets(self, event.showId, event.seasonNumber, event.episodeNumber, opts);

  switch (type) {
    case 'grab_sent':
      // recordGrabbedRelease already did this; refreshes the detail line.
      applyToTargets(self, targetsFor(), {
        state: 'grabbed_downloading', blocker: null, detail: event.message, releaseTitle: event.releaseTitle ?? null, meta: null,
      }, nowIso);
      return;
    case 'grab_failed':
      applyToTargets(self, targetsFor(), {
        state: 'stuck', blocker: event.reasonCode ?? 'grab_failed', detail: event.message, releaseTitle: event.releaseTitle ?? null,
      }, nowIso);
      return;
    case 'search_no_indexers':
      applyToTargets(self, targetsFor(), {
        state: 'stuck', blocker: 'NO_INDEXERS_CONFIGURED', detail: event.message,
      }, nowIso);
      return;
    case 'release_rejected': {
      // Stash the rejection breakdown; search_completed right after decides the state.
      const breakdown = event.metadata?.breakdown ?? null;
      for (const t of targetsFor()) {
        const cur = getEpisodeStatus(self, t);
        setEpisodeStatus(self, t, {
          state: cur?.state ?? 'not_found',
          meta: { rejected: breakdown, at: nowIso },
        }, nowIso);
      }
      return;
    }
    case 'search_completed': {
      const passed = Number(event.metadata?.passedFiltering ?? NaN);
      const found = Number(event.metadata?.resultsFound ?? NaN);
      if (!(passed === 0)) return; // a pick was made; grab/miss events follow
      const allRejected = found > 0;
      for (const t of targetsFor()) {
        const cur = getEpisodeStatus(self, t);
        const curMeta = cur?.meta_json ? safeJson(cur.meta_json) : null;
        const freshRejects = curMeta?.at && Date.parse(nowIso) - Date.parse(curMeta.at) < SAME_SEARCH_WINDOW_MS;
        setEpisodeStatus(self, t, {
          state: 'not_found',
          blocker: allRejected ? 'REJECTED_BY_PROFILE' : 'NO_RESULTS_FOUND',
          detail: event.message,
          meta: { resultsFound: found, rejected: freshRejects ? curMeta.rejected ?? null : null, at: nowIso },
        }, nowIso);
      }
      return;
    }
    case 'no_qualifying_releases':
    case 'not_upgrade': {
      for (const t of targetsFor()) {
        const cur = getEpisodeStatus(self, t);
        // search_completed a moment ago already recorded the richer reason.
        if (cur?.state === 'not_found' && Date.parse(nowIso) - Date.parse(cur.updated_at) < SAME_SEARCH_WINDOW_MS && type === 'no_qualifying_releases') continue;
        setEpisodeStatus(self, t, {
          state: 'not_found', blocker: event.reasonCode ?? 'NO_RESULTS_FOUND', detail: event.message,
          releaseTitle: event.releaseTitle ?? null,
        }, nowIso);
      }
      return;
    }
    case 'import_started':
      applyToTargets(self, targetsFor(), {
        state: 'importing', blocker: null, detail: event.message, releaseTitle: event.releaseTitle ?? undefined,
      }, nowIso);
      return;
    case 'download_failed':
      // core/release_failures.ts: grab marked failed + release blocklisted;
      // explain.ts reads this as "failed, blocklisted, re-searching".
      applyToTargets(self, targetsFor(), {
        state: 'stuck', blocker: event.reasonCode ?? 'download_failed', detail: event.message, releaseTitle: event.releaseTitle ?? undefined,
      }, nowIso);
      return;
    case 'import_failed':
    case 'import_skipped':
      applyToTargets(self, targetsFor(), {
        state: 'stuck', blocker: event.reasonCode ?? type, detail: event.message, releaseTitle: event.releaseTitle ?? undefined,
      }, nowIso);
      return;
    case 'import_completed':
      applyToTargets(self, targetsFor({ includeOnDisk: true }), {
        state: 'done', blocker: null, detail: event.message, releaseTitle: event.releaseTitle ?? undefined, meta: null,
      }, nowIso);
      return;
    default:
      return;
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Status update keyed by release title - for the download client, which
 * only knows the title it was handed. Resolves the most recent grab with
 * that normalized title (within `withinHours`) to its episode / season /
 * movie target. Returns how many rows were updated.
 */
export function setStatusForRelease(
  self: DatabaseManager,
  releaseTitle: string,
  update: StatusUpdate,
  withinHours = 72,
  nowIso = new Date().toISOString(),
): number {
  const normalized = normalizeReleaseTitle(releaseTitle);
  if (!normalized) return 0;
  const cutoff = new Date(Date.parse(nowIso) - withinHours * 3_600_000).toISOString();
  const grab = self.db.query(`
    SELECT show_id, season_number, episode_number FROM grabbed_releases
    WHERE normalized_title = ? AND replace(grabbed_at, ' ', 'T') >= ?
    ORDER BY id DESC LIMIT 1
  `).get(normalized, cutoff) as { show_id: string; season_number: number | null; episode_number: number | null } | null;
  if (!grab) return 0;
  const targets = resolveStatusTargets(self, grab.show_id, grab.season_number, grab.episode_number);
  applyToTargets(self, targets, { releaseTitle, ...update }, nowIso);
  return targets.length;
}

/**
 * Retention for the status table: drop `done` rows older than the cutoff
 * (explain() reads file_path for done-ness anyway) and rows whose episode
 * no longer exists. Non-terminal rows are never pruned, so the daily event
 * cleanup can't silently revert a stuck item to "wanted".
 */
export function pruneEpisodeStatus(self: DatabaseManager, beforeIso: string): number {
  const done = self.db.query(`DELETE FROM episode_status WHERE state = 'done' AND updated_at < ?`).run(beforeIso);
  const orphans = self.db.query(`
    DELETE FROM episode_status
    WHERE NOT (season_number = 0 AND episode_number = 0)
      AND NOT EXISTS (
        SELECT 1 FROM episodes e
        WHERE e.show_id = episode_status.show_id
          AND e.season_number = episode_status.season_number
          AND e.episode_number = episode_status.episode_number
      )
  `).run();
  return (done.changes ?? 0) + (orphans.changes ?? 0);
}
