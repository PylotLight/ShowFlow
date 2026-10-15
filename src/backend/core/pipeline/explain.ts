import type { DatabaseManager } from '../../db';
import { GRAB_GATES, grabGateParams, normalizeReleaseTitle, searchBackoffUntil } from '../../db/grabs';
import type { EpisodeStatusRow } from '../../db/episode_status';
import { MOVIE_STATUS_EPISODE, MOVIE_STATUS_SEASON } from '../../db/episode_status';
import { buildAirDateTime, DEFAULT_RELEASE_DELAY_MINUTES } from '../air_window';
import { GRAB_INFLIGHT_HOURS, isDueForSearch } from '../auto_grabber';
import { describeReasonCode } from './reason_codes';

/**
 * "Why hasn't this episode been pulled?" - one answer per episode, built
 * from the same auto-grab gates as listEpisodesDueForGrab (db/grabs.ts
 * GRAB_GATES, selected here as columns) plus the persisted episode_status
 * row (last grab / import / search outcome) and, when cheap, live TorBox
 * progress from the in-memory download client.
 */

export type ExplainState =
  | 'not_tracked'
  | 'manual_only'
  | 'waiting_air'
  | 'waiting_release_delay'
  | 'searching'
  | 'not_found'
  | 'grabbed_downloading'
  | 'importing'
  | 'stuck'
  | 'done';

export type ExplainAction = 'search_now' | 'open_show' | 'change_search_mode' | 'retry' | null;

export interface Explanation {
  state: ExplainState;
  /** Short machine reason (gate name / reason code), null when nothing blocks. */
  blocker: string | null;
  /** Plain-English reason line for the UI. */
  detail: string;
  /** When the pipeline will next look at it on its own (ISO), if known. */
  nextCheckAt: string | null;
  /** Suggested one-click fix. */
  action: ExplainAction;
  /** When the current wait started (ISO): release time for wanted, grab time for in-flight. */
  waitingSince: string | null;
  /** True iff auto-grab would pick this episode this cycle (listEpisodesDueForGrab + isDueForSearch). */
  dueNow: boolean;
  /** Search backoff state for searching / not_found. */
  attempts: number;
  lastSearchedAt: string | null;
  /** TorBox progress 0-100 when known. */
  progress: number | null;
  releaseTitle: string | null;
}

/** Grabbed this long ago with no live progress = stuck. Below GRAB_INFLIGHT_HOURS on purpose. */
export const STUCK_AFTER_HOURS = 6;
/** An import that started this long ago and never finished = stuck. */
export const IMPORT_STUCK_AFTER_HOURS = 2;
/** Attention list shows upcoming episodes airing within this window. */
export const UPCOMING_WINDOW_DAYS = 7;

export interface ExplainInput {
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle: string | null;
  airDate: string | null;
  airTime: string | null;
  expectedReleaseAt: string | null;
  releaseDelayMinutes: number | null;
  searchMode: string | null;
  isMovie: boolean;
  searchAttempts: number;
  lastSearchedAt: string | null;
  filePath: string | null;
  /** Each GRAB_GATES predicate as evaluated by SQL for this row. */
  gates: Record<keyof typeof GRAB_GATES, boolean>;
  /** Most recent grab for exactly this episode (ISO), if any. */
  lastGrabAt: string | null;
  status: Pick<EpisodeStatusRow, 'state' | 'blocker' | 'detail' | 'release_title' | 'meta_json' | 'since' | 'updated_at'> | null;
  live?: { state: string; progress: number | null } | null;
}

export interface ExplainOptions {
  nowMs: number;
  inflightHours?: number;
  stuckAfterHours?: number;
  /** Next scheduled auto-grab run (ISO), for "queued" items. */
  nextAutoGrabAt?: string | null;
}

const HOUR = 3_600_000;

/** Movie status rows that mean a grab is still being worked on (movies have no cooldown key). */
const MOVIE_ACTIVE_STATES = new Set(['grabbed_downloading', 'importing', 'stuck']);

function plusMs(iso: string | null, ms: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + ms).toISOString();
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function fmtIn(ms: number): string {
  if (ms <= 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function rejectSummary(metaJson: string | null): string {
  if (!metaJson) return '';
  try {
    const meta = JSON.parse(metaJson);
    const br = meta?.rejected as Record<string, number> | null | undefined;
    if (!br) return '';
    const parts = Object.entries(br)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([code, n]) => `${n} ${(describeReasonCode(code)?.label ?? code).toLowerCase()}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
  } catch {
    return '';
  }
}

/** Release instant isDueForSearch uses: air datetime + delay, else the stored forecast. */
function releaseInstant(i: ExplainInput): { airAt: Date | null; releaseAt: Date | null } {
  const airAt = i.airDate ? buildAirDateTime(i.airDate, i.airTime) : null;
  if (airAt) {
    const delay = (i.releaseDelayMinutes ?? DEFAULT_RELEASE_DELAY_MINUTES) * 60_000;
    let releaseAt = new Date(airAt.getTime() + delay);
    // SQL's `released` gate also needs the stored forecast (if any) to have passed.
    if (i.expectedReleaseAt) {
      const exp = new Date(i.expectedReleaseAt);
      if (!Number.isNaN(exp.getTime()) && exp > releaseAt) releaseAt = exp;
    }
    return { airAt, releaseAt };
  }
  const exp = i.expectedReleaseAt ? new Date(i.expectedReleaseAt) : null;
  return { airAt: null, releaseAt: exp && !Number.isNaN(exp.getTime()) ? exp : null };
}

/**
 * Status blockers left by a failed download whose release was blocklisted
 * (core/release_failures.ts). Outside the in-flight window they mean
 * "re-searching", not stuck.
 */
const FAILED_BLOCKLISTED_BLOCKERS = new Set(['torbox_failed', 'RELEASE_FAILED_BLOCKLISTED', 'download_failed']);

/**
 * Pure: classify one episode. Order mirrors how the pipeline actually
 * treats it - a file on disk wins, then the hard gates (tracked, search
 * mode, movie), then anything in flight (12h grab cooldown), then the air
 * window, then the search backoff.
 */
export function explainEpisode(i: ExplainInput, opts: ExplainOptions): Explanation {
  const now = opts.nowMs;
  const inflightMs = (opts.inflightHours ?? GRAB_INFLIGHT_HOURS) * HOUR;
  const stuckMs = (opts.stuckAfterHours ?? STUCK_AFTER_HOURS) * HOUR;
  const st = i.status;
  const { airAt, releaseAt } = releaseInstant(i);
  const dueNow =
    Object.values(i.gates).every(Boolean) &&
    isDueForSearch({
      air_date: i.airDate, air_time: i.airTime,
      expected_release_at: i.expectedReleaseAt, release_delay_minutes: i.releaseDelayMinutes,
    }, now);

  const base = {
    nextCheckAt: null as string | null,
    waitingSince: null as string | null,
    dueNow,
    attempts: i.searchAttempts ?? 0,
    lastSearchedAt: i.lastSearchedAt,
    progress: null as number | null,
    releaseTitle: st?.release_title ?? null,
  };
  const out = (state: ExplainState, blocker: string | null, detail: string, action: ExplainAction, extra: Partial<Explanation> = {}): Explanation =>
    ({ ...base, state, blocker, detail, action, ...extra });

  // 1. On disk.
  if (!i.gates.missing) {
    return out('done', null, 'On disk', null, { waitingSince: null, releaseTitle: st?.release_title ?? null });
  }

  // 2. In flight (a grab inside the cooldown) - checked before the hard
  // gates so a manually grabbed untracked episode / movie still shows its
  // download. Movies have no grabbed_releases episode key, so their
  // in-flight signal is the status row itself.
  const movieActive = i.isMovie && !!st && MOVIE_ACTIVE_STATES.has(st.state);
  const grabAt = i.lastGrabAt ?? (movieActive ? st!.since : null);
  const grabMs = grabAt ? Date.parse(grabAt) : NaN;
  const inflight = i.isMovie ? movieActive : !i.gates.notInflight;
  if (inflight) {
    const retryAt = plusMs(grabAt, inflightMs);
    const since = grabAt ?? st?.since ?? null;
    const statusFresh = st && grabAt ? st.updated_at >= grabAt : !!st;
    const autoRetry = i.gates.tracked && i.gates.autoMode && !i.isMovie;
    if (st && statusFresh && st.state === 'stuck') {
      const why = st.blocker === 'torbox_failed' ? 'TorBox reports the download failed'
        : st.blocker === 'import_failed' ? 'import failed'
        : st.detail ?? 'download failed';
      return out('stuck', st.blocker, `Stuck: ${why}${autoRetry && retryAt ? ` — auto-retry ${fmtWhen(retryAt, now)}` : ''}`, 'retry',
        { waitingSince: st.since, nextCheckAt: autoRetry ? retryAt : null });
    }
    if (st && statusFresh && st.state === 'importing') {
      const age = now - Date.parse(st.since);
      if (age > IMPORT_STUCK_AFTER_HOURS * HOUR) {
        return out('stuck', 'import_stalled', `Stuck: import started ${fmtIn(age)} ago and never finished`, 'retry',
          { waitingSince: st.since, nextCheckAt: autoRetry ? retryAt : null });
      }
      return out('importing', null, `Importing${st.release_title ? ` "${st.release_title}"` : ''}`, null, { waitingSince: st.since });
    }
    if (i.live) {
      const p = i.live.progress;
      const detail = p != null ? `Downloading ${p}%` : `Downloading — TorBox: ${i.live.state}`;
      return out('grabbed_downloading', null, detail, null, { waitingSince: since, progress: p, nextCheckAt: null });
    }
    const age = Number.isNaN(grabMs) ? 0 : now - grabMs;
    if (age > stuckMs) {
      return out('stuck', 'no_progress', `Stuck: grabbed ${fmtIn(age)} ago, no download progress${autoRetry && retryAt ? ` — auto-retry ${fmtWhen(retryAt, now)}` : ''}`, 'retry',
        { waitingSince: since, nextCheckAt: autoRetry ? retryAt : null });
    }
    const when = age < 60_000 ? 'just now' : `${fmtIn(age)} ago`;
    return out('grabbed_downloading', null, `Sent to download client ${when}, waiting for it to land`, null,
      { waitingSince: since, nextCheckAt: autoRetry ? retryAt : null });
  }

  // 3. Hard gates.
  if (i.isMovie || !i.gates.notMovie) {
    return out('manual_only', 'movie', 'Movies aren\'t auto-grabbed — search for it manually', 'search_now');
  }
  if (!i.gates.tracked) {
    return out('not_tracked', 'tracked', 'Not monitored — auto-grab skips it', 'open_show');
  }
  if (!i.gates.autoMode) {
    const released = releaseAt ? releaseAt.getTime() <= now : false;
    return out('manual_only', 'search_mode', `Search mode is manual — auto-grab skips it${released ? '' : ' (not released yet)'}`,
      'change_search_mode', { waitingSince: released && releaseAt ? releaseAt.toISOString() : null });
  }

  // 4. Air window.
  if (!releaseAt) {
    return out('waiting_air', 'no_air_date', 'Air date TBA — nothing to search for yet', null);
  }
  if (!i.gates.released || !dueNowIgnoringGates(i, now)) {
    if (airAt && airAt.getTime() > now) {
      return out('waiting_air', 'released', `Waiting for air on ${fmtDay(airAt)}`, null, { nextCheckAt: releaseAt.toISOString() });
    }
    return out('waiting_release_delay', 'released',
      `Aired, waiting for the release delay — first search in ${fmtIn(releaseAt.getTime() - now)}`, null,
      { nextCheckAt: releaseAt.toISOString() });
  }

  const wantedSince = releaseAt.toISOString();

  // 5a. The last grab failed (TorBox gave up / import failed / marked failed
  // by hand): the grab row is 'failed' so it no longer counts as in flight,
  // the release is blocklisted and the miss backoff was reset - it goes
  // straight back into search. Only until the next search lands.
  if (dueNow && st && st.state === 'stuck' && FAILED_BLOCKLISTED_BLOCKERS.has(st.blocker ?? '')
      && (!i.lastSearchedAt || st.updated_at >= i.lastSearchedAt)) {
    const queuedFail = opts.nextAutoGrabAt ? ` — next auto-grab ${fmtWhen(opts.nextAutoGrabAt, now)}` : ' on the next auto-grab run';
    return out('searching', 'release_failed',
      `Failed, blocklisted, re-searching${st.release_title ? ` ("${st.release_title}")` : ''}${queuedFail}`, 'search_now',
      { waitingSince: wantedSince, nextCheckAt: opts.nextAutoGrabAt ?? null });
  }

  // 5. Persistent blockers from the last attempt that the gates can't see.
  if (st && st.state === 'stuck' && (st.blocker === 'NO_INDEXERS_CONFIGURED' || /^grab_failed/i.test(st.blocker ?? ''))
      && (!i.lastSearchedAt || st.updated_at >= i.lastSearchedAt)) {
    const why = st.blocker === 'NO_INDEXERS_CONFIGURED' ? 'no indexers configured' : (describeReasonCode(st.blocker)?.label ?? 'grab failed').toLowerCase();
    return out('stuck', st.blocker, `Stuck: ${why}`, 'retry', { waitingSince: wantedSince, nextCheckAt: dueNow ? opts.nextAutoGrabAt ?? null : searchBackoffUntil(i.lastSearchedAt, i.searchAttempts) });
  }

  // 6. Search backoff.
  const attempts = i.searchAttempts ?? 0;
  const missReason = (() => {
    if (st?.state !== 'not_found') return 'nothing grabbed';
    if (st.blocker === 'REJECTED_BY_PROFILE') return `nothing matched your profile${rejectSummary(st.meta_json)}`;
    if (st.blocker === 'NOT_AN_UPGRADE') return 'only non-upgrades found';
    if (st.blocker === 'NO_RESULTS_FOUND') return 'no releases found';
    return 'nothing grabbed';
  })();
  if (!i.gates.outsideBackoff) {
    const next = searchBackoffUntil(i.lastSearchedAt, attempts);
    const inTxt = next ? ` — next try in ${fmtIn(Date.parse(next) - now)}` : '';
    return out('not_found', st?.blocker ?? 'backoff', `Searched ${attempts}x, ${missReason}${inTxt}`, 'search_now',
      { waitingSince: wantedSince, nextCheckAt: next });
  }
  const queued = opts.nextAutoGrabAt ? ` — next auto-grab ${fmtWhen(opts.nextAutoGrabAt, now)}` : ' on the next auto-grab run';
  if (attempts > 0 && i.lastSearchedAt) {
    return out('searching', null, `Searched ${attempts}x, ${missReason} — retrying${queued}`, 'search_now',
      { waitingSince: wantedSince, nextCheckAt: opts.nextAutoGrabAt ?? null });
  }
  return out('searching', null, `Queued for search${queued}`, 'search_now',
    { waitingSince: wantedSince, nextCheckAt: opts.nextAutoGrabAt ?? null });
}

function dueNowIgnoringGates(i: ExplainInput, now: number): boolean {
  return isDueForSearch({
    air_date: i.airDate, air_time: i.airTime,
    expected_release_at: i.expectedReleaseAt, release_delay_minutes: i.releaseDelayMinutes,
  }, now);
}

function fmtWhen(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return 'soon';
  if (ms <= 60_000) return 'any minute';
  return `in ${fmtIn(ms)}`;
}

// ---- Batch loader ---------------------------------------------------------

export interface ExplainedEpisode extends Explanation {
  showId: string;
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle: string | null;
  airDate: string | null;
  searchMode: string;
  filePath: string | null;
  isMovie: boolean;
}

export interface ExplainFilter {
  /** Only tracked episodes without a file (plus in-flight/stuck movies and untracked eps with a live status). Default true. */
  pipelineOnly?: boolean;
  /** Include on-disk tracked episodes (legacy kanban AVAILABLE lane). */
  includeDone?: boolean;
  showId?: string;
  season?: number;
  episode?: number;
}

export interface LiveDownload { title: string; state: string; progress: number | null }

/**
 * Map live TorBox downloads (by release title) to episode keys via the
 * recent grabs table - one query, no per-item lookups.
 */
export function buildLiveIndex(self: DatabaseManager, live: LiveDownload[], nowMs = Date.now()): Map<string, { state: string; progress: number | null }> {
  const out = new Map<string, { state: string; progress: number | null }>();
  if (live.length === 0) return out;
  const byTitle = new Map(live.map(d => [normalizeReleaseTitle(d.title), d]));
  const cutoff = new Date(nowMs - 72 * HOUR).toISOString();
  const grabs = self.db.query(`
    SELECT g.show_id, g.season_number, g.episode_number, g.normalized_title, s.series_type
    FROM grabbed_releases g LEFT JOIN shows s ON s.id = g.show_id
    WHERE replace(g.grabbed_at, ' ', 'T') >= ?
    ORDER BY g.id DESC
  `).all(cutoff) as { show_id: string; season_number: number | null; episode_number: number | null; normalized_title: string; series_type: string | null }[];
  for (const g of grabs) {
    const d = byTitle.get(g.normalized_title);
    if (!d) continue;
    const val = { state: d.state, progress: d.progress };
    if (g.season_number != null && g.episode_number != null) {
      const k = keyOf(g.show_id, g.season_number, g.episode_number);
      if (!out.has(k)) out.set(k, val);
    } else if (g.season_number != null) {
      out.set(`${g.show_id}:${g.season_number}:*`, val);
    } else if (g.series_type === 'movie') {
      out.set(keyOf(g.show_id, MOVIE_STATUS_SEASON, MOVIE_STATUS_EPISODE), val);
    }
  }
  return out;
}

export function keyOf(showId: string, season: number, episode: number): string {
  return `${showId}:${season}:${episode}`;
}

/** Next scheduled auto-grab run, if the task is enabled. */
export function nextAutoGrabRun(self: DatabaseManager): string | null {
  try {
    const row = self.db.query(`SELECT next_execution, enabled FROM scheduled_tasks WHERE name = 'auto-grab'`).get() as { next_execution: string | null; enabled: number | null } | null;
    if (!row || row.enabled === 0) return null;
    return row.next_execution ? row.next_execution.replace(' ', 'T') : null;
  } catch {
    return null;
  }
}

const GATE_COLUMNS = (Object.keys(GRAB_GATES) as (keyof typeof GRAB_GATES)[])
  .map(k => `CASE WHEN ${GRAB_GATES[k]} THEN 1 ELSE 0 END AS g_${k}`)
  .join(',\n      ');

/**
 * Explain many episodes in one query (gates as columns + status join +
 * latest-grab subquery), plus one small query for movie status rows.
 * No per-episode round trips.
 */
export function explainEpisodes(
  self: DatabaseManager,
  filter: ExplainFilter = {},
  opts: { nowMs?: number; live?: Map<string, { state: string; progress: number | null }>; nextAutoGrabAt?: string | null } = {},
): ExplainedEpisode[] {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownIso = new Date(nowMs - GRAB_INFLIGHT_HOURS * HOUR).toISOString();
  const params: Record<string, string | number> = { ...grabGateParams(nowIso, cooldownIso) };
  const where: string[] = [];
  const pipelineOnly = filter.pipelineOnly ?? true;
  if (pipelineOnly) {
    // Tracked & missing, or anything with a non-terminal status (manual grab of an untracked ep).
    where.push(`(
      (e.is_tracked = 1 AND (${filter.includeDone ? '1=1' : GRAB_GATES.missing}))
      OR (st.state IS NOT NULL AND st.state NOT IN ('done', 'not_found') AND ${GRAB_GATES.missing})
    )`);
  }
  if (filter.showId) { where.push('e.show_id = $showId'); params.$showId = filter.showId; }
  if (filter.season != null) { where.push('e.season_number = $season'); params.$season = filter.season; }
  if (filter.episode != null) { where.push('e.episode_number = $episode'); params.$episode = filter.episode; }

  const rows = self.db.query(`
    SELECT
      e.show_id, e.season_number, e.episode_number, e.title AS episode_title,
      e.air_date, e.air_time, e.expected_release_at, e.search_mode, e.file_path,
      e.search_attempts, e.last_searched_at,
      s.title AS show_title, s.series_type, s.release_delay_minutes,
      ${GATE_COLUMNS},
      (SELECT MAX(replace(g.grabbed_at, ' ', 'T')) FROM grabbed_releases g
        WHERE g.show_id = e.show_id AND g.season_number = e.season_number
          AND (g.episode_number = e.episode_number OR g.episode_number IS NULL)
          AND g.status != 'failed') AS last_grab_at,
      st.state AS st_state, st.blocker AS st_blocker, st.detail AS st_detail, st.release_title AS st_release_title,
      st.meta_json AS st_meta_json, st.since AS st_since, st.updated_at AS st_updated_at
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    LEFT JOIN episode_status st
      ON st.show_id = e.show_id AND st.season_number = e.season_number AND st.episode_number = e.episode_number
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.title ASC, e.season_number ASC, e.episode_number ASC
  `).all(params) as any[];

  const live = opts.live ?? new Map();
  const nextAutoGrabAt = opts.nextAutoGrabAt === undefined ? nextAutoGrabRun(self) : opts.nextAutoGrabAt;
  const result: ExplainedEpisode[] = [];

  for (const r of rows) {
    const input: ExplainInput = {
      showId: r.show_id, showTitle: r.show_title, season: r.season_number, episode: r.episode_number,
      episodeTitle: r.episode_title ?? null, airDate: r.air_date || null, airTime: r.air_time || null,
      expectedReleaseAt: r.expected_release_at || null, releaseDelayMinutes: r.release_delay_minutes ?? null,
      searchMode: r.search_mode ?? 'auto', isMovie: r.series_type === 'movie',
      searchAttempts: r.search_attempts ?? 0, lastSearchedAt: r.last_searched_at ?? null, filePath: r.file_path || null,
      gates: {
        tracked: !!r.g_tracked, autoMode: !!r.g_autoMode, missing: !!r.g_missing, notMovie: !!r.g_notMovie,
        released: !!r.g_released, notInflight: !!r.g_notInflight, outsideBackoff: !!r.g_outsideBackoff,
      },
      lastGrabAt: r.last_grab_at ?? null,
      status: r.st_state ? {
        state: r.st_state, blocker: r.st_blocker, detail: r.st_detail, release_title: r.st_release_title,
        meta_json: r.st_meta_json, since: r.st_since, updated_at: r.st_updated_at,
      } : null,
      live: live.get(keyOf(r.show_id, r.season_number, r.episode_number)) ?? live.get(`${r.show_id}:${r.season_number}:*`) ?? null,
    };
    result.push(toExplained(input, explainEpisode(input, { nowMs, nextAutoGrabAt })));
  }

  // Movies: no episodes rows; their status lives on S0E0.
  if (filter.season == null || filter.season === MOVIE_STATUS_SEASON) {
    const movieParams: Record<string, string> = {};
    let movieWhere = `s.series_type = 'movie' AND st.season_number = 0 AND st.episode_number = 0`;
    if (pipelineOnly && !filter.includeDone) movieWhere += ` AND st.state IN ('grabbed_downloading', 'importing', 'stuck')`;
    if (filter.showId) { movieWhere += ' AND st.show_id = $showId'; movieParams.$showId = filter.showId; }
    const movies = self.db.query(`
      SELECT st.*, s.title AS show_title,
        (SELECT ef.file_path FROM episode_files ef
          WHERE ef.show_id = st.show_id AND ef.season_number = 0 AND ef.episode_number = 0 AND ef.is_current = 1
          ORDER BY ef.id DESC LIMIT 1) AS movie_file
      FROM episode_status st JOIN shows s ON s.id = st.show_id
      WHERE ${movieWhere}
    `).all(movieParams) as any[];
    for (const m of movies) {
      const hasFile = !!m.movie_file;
      if (pipelineOnly && !filter.includeDone && hasFile) continue;
      const input: ExplainInput = {
        showId: m.show_id, showTitle: m.show_title, season: 0, episode: 0, episodeTitle: null,
        airDate: null, airTime: null, expectedReleaseAt: null, releaseDelayMinutes: null, searchMode: 'interactive',
        isMovie: true, searchAttempts: 0, lastSearchedAt: null, filePath: m.movie_file ?? null,
        gates: { tracked: false, autoMode: false, missing: !hasFile, notMovie: false, released: true, notInflight: true, outsideBackoff: true },
        lastGrabAt: null,
        status: { state: m.state, blocker: m.blocker, detail: m.detail, release_title: m.release_title, meta_json: m.meta_json, since: m.since, updated_at: m.updated_at },
        live: live.get(keyOf(m.show_id, 0, 0)) ?? null,
      };
      result.push(toExplained(input, explainEpisode(input, { nowMs, nextAutoGrabAt })));
    }
  }
  return result;
}

function toExplained(i: ExplainInput, e: Explanation): ExplainedEpisode {
  return {
    ...e,
    showId: i.showId, showTitle: i.showTitle, season: i.season, episode: i.episode,
    episodeTitle: i.episodeTitle, airDate: i.airDate, searchMode: i.searchMode ?? 'auto',
    filePath: i.filePath, isMovie: i.isMovie,
  };
}

// ---- Attention list -------------------------------------------------------

/** States the sidebar badge counts (the old WANTED/SEARCHING/FAILED lanes). */
export const ATTENTION_BADGE_STATES = new Set<ExplainState>(['searching', 'not_found', 'stuck']);

/**
 * Belongs on the "Needs attention" list: everything not done/untracked,
 * except upcoming episodes more than UPCOMING_WINDOW_DAYS out (or TBA) and
 * manual-mode episodes that haven't released yet.
 */
export function isAttentionItem(e: ExplainedEpisode, nowMs: number): boolean {
  if (e.state === 'done' || e.state === 'not_tracked') return false;
  if (e.state === 'waiting_air') {
    if (!e.nextCheckAt) return false;
    return Date.parse(e.nextCheckAt) - nowMs <= UPCOMING_WINDOW_DAYS * 24 * HOUR;
  }
  if (e.state === 'manual_only' && e.blocker === 'search_mode' && !e.waitingSince) return false;
  return true;
}

/** Oldest wait first; upcoming (no wait yet) last, soonest first. */
export function compareAttention(a: ExplainedEpisode, b: ExplainedEpisode): number {
  const aw = a.waitingSince ? Date.parse(a.waitingSince) : null;
  const bw = b.waitingSince ? Date.parse(b.waitingSince) : null;
  if (aw != null && bw != null && aw !== bw) return aw - bw;
  if (aw != null && bw == null) return -1;
  if (aw == null && bw != null) return 1;
  if (aw == null && bw == null) {
    const an = a.nextCheckAt ? Date.parse(a.nextCheckAt) : Infinity;
    const bn = b.nextCheckAt ? Date.parse(b.nextCheckAt) : Infinity;
    if (an !== bn) return an - bn;
  }
  return a.showTitle.localeCompare(b.showTitle) || a.season - b.season || a.episode - b.episode;
}

/** Legacy kanban lane for an explained episode (null = hidden). */
export function kanbanStageFor(e: ExplainedEpisode): string | null {
  switch (e.state) {
    case 'done': return 'AVAILABLE';
    case 'grabbed_downloading': return 'GRABBED';
    case 'importing': return 'IMPORTING';
    case 'stuck': return 'FAILED';
    case 'not_found': return 'SEARCHING';
    case 'searching':
    case 'waiting_release_delay':
    case 'manual_only': return e.state === 'manual_only' && !e.waitingSince ? null : 'WANTED';
    default: return null;
  }
}

// ---- Legacy kanban + summary (same explain() source) -----------------------

export interface KanbanEpisode {
  showId: string;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDate: string | null;
  filePath: string | null;
  currentStage: string;
  /** New: explain() state + reason line. */
  state: ExplainState;
  message: string | null;
  reasonCode: string | null;
  releaseTitle: string | null;
  eventCreatedAt: string | null;
  searchMode: string;
  // Kept for old clients; always null now (no per-row event join).
  eventId: null;
  eventType: null;
  reasonCategory: null;
}

/** Lanes the "needs attention" badge counts, same as before the rework. */
export const ATTENTION_STAGES = new Set(['WANTED', 'SEARCHING', 'FAILED']);

export function listKanbanEpisodes(
  self: DatabaseManager,
  opts: { includeAvailable?: boolean; nowMs?: number; live?: Map<string, { state: string; progress: number | null }> } = {},
): KanbanEpisode[] {
  const explained = explainEpisodes(self, { includeDone: !!opts.includeAvailable }, { nowMs: opts.nowMs, live: opts.live });
  const out: KanbanEpisode[] = [];
  for (const e of explained) {
    const stage = kanbanStageFor(e);
    if (!stage) continue;
    if (stage === 'AVAILABLE' && !opts.includeAvailable) continue;
    out.push({
      showId: e.showId, showTitle: e.showTitle, seasonNumber: e.season, episodeNumber: e.episode,
      episodeTitle: e.episodeTitle, airDate: e.airDate, filePath: e.filePath, currentStage: stage,
      state: e.state, message: e.detail, reasonCode: e.blocker, releaseTitle: e.releaseTitle,
      eventCreatedAt: e.waitingSince, searchMode: e.searchMode,
      eventId: null, eventType: null, reasonCategory: null,
    });
  }
  return out;
}

export interface PipelineSummary {
  /** Items on the kanban (excluding AVAILABLE). */
  total: number;
  /** Items in WANTED/SEARCHING/FAILED lanes (sidebar badge). */
  attentionCount: number;
  /** Items on the Needs attention list. */
  needsAttention: number;
  byState: Partial<Record<ExplainState, number>>;
}

/**
 * Counts for the sidebar badge poll. One explainEpisodes() pass over
 * tracked-missing episodes (a few hundred rows), so it can never disagree
 * with the kanban or attention list.
 */
export function getPipelineSummary(self: DatabaseManager, nowMs = Date.now()): PipelineSummary {
  const explained = explainEpisodes(self, {}, { nowMs, nextAutoGrabAt: null });
  const byState: Partial<Record<ExplainState, number>> = {};
  let total = 0;
  let attentionCount = 0;
  let needsAttention = 0;
  for (const e of explained) {
    byState[e.state] = (byState[e.state] ?? 0) + 1;
    const stage = kanbanStageFor(e);
    if (stage && stage !== 'AVAILABLE') {
      total++;
      if (ATTENTION_STAGES.has(stage)) attentionCount++;
    }
    if (isAttentionItem(e, nowMs)) needsAttention++;
  }
  return { total, attentionCount, needsAttention, byState };
}

export interface AttentionPage {
  items: ExplainedEpisode[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Paginated "Needs attention" list, oldest wait first. */
export function listAttention(
  self: DatabaseManager,
  opts: { limit?: number; offset?: number; showId?: string; nowMs?: number; live?: Map<string, { state: string; progress: number | null }> } = {},
): AttentionPage {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const items = explainEpisodes(self, { showId: opts.showId }, { nowMs, live: opts.live })
    .filter(e => isAttentionItem(e, nowMs))
    .sort(compareAttention);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length };
}
