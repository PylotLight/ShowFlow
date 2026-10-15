import { db } from '../db';
import type { GrabbedReleaseRow } from '../db/grabs';

/**
 * Failed-download handling: one funnel for every way a grabbed release can
 * die (TorBox error/dead/stalled, bad import, "mark failed" by hand).
 *
 * Marking a grab failed:
 *   - sets grabbed_releases.status='failed' (+ reason / failed_at) for that
 *     grab AND every sibling row of the same release (packs and multi-ep
 *     releases record one row per covered episode),
 *   - blocklists the release for the show (by info hash + normalized title)
 *     so search and RSS skip it from now on,
 *   - frees the auto-grab 12h in-flight cooldown (failed rows don't count)
 *     and resets the search backoff, so the next auto-grab / RSS cycle
 *     re-searches the episode immediately for a different release.
 */

export type FailureSource = 'torbox' | 'import' | 'manual';

export interface MarkFailedResult {
  failedGrabIds: number[];
  blocklistId: number | null;
}

/** Siblings = same show + same release (hash, else normalized title), not yet failed. */
function siblingsOf(grab: GrabbedReleaseRow): GrabbedReleaseRow[] {
  return db.db.query(`
    SELECT * FROM grabbed_releases
    WHERE show_id = ? AND id != ? AND status IN ('grabbed', 'downloading', 'completed')
      AND ((? IS NOT NULL AND info_hash = ?) OR normalized_title = ?)
      AND replace(grabbed_at, ' ', 'T') >= ?
  `).all(
    grab.show_id, grab.id, grab.info_hash, grab.info_hash, grab.normalized_title,
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  ) as GrabbedReleaseRow[];
}

export function markReleaseFailed(input: {
  grabId: number;
  reason: string;
  source: FailureSource;
  /** Default true. */
  blocklist?: boolean;
}): MarkFailedResult | null {
  const grab = db.getGrab(input.grabId);
  if (!grab) return null;
  const rows = [grab, ...siblingsOf(grab)];
  const reason = `${input.source}: ${input.reason}`;
  const nowIso = new Date().toISOString();

  let blocklistId: number | null = null;
  db.db.transaction(() => {
    for (const r of rows) db.markGrabFailed(r.id, reason, nowIso);
    if (input.blocklist !== false) {
      const episodes = rows.map(r => r.episode_number).filter((n): n is number => n != null);
      blocklistId = db.addToBlocklist({
        showId: grab.show_id,
        season: grab.season_number,
        episodes,
        releaseTitle: grab.release_title,
        infoHash: grab.info_hash,
        indexerName: grab.indexer_name,
        reason,
      });
    }
    // Re-search right away: clear the miss backoff for the covered episodes
    // (a season-pack row with no episode resets the whole season).
    for (const r of rows) {
      if (r.season_number == null) continue;
      db.db.query(`
        UPDATE episodes SET last_searched_at = NULL, search_attempts = 0
        WHERE show_id = ? AND season_number = ? AND (? IS NULL OR episode_number = ?)
      `).run(r.show_id, r.season_number, r.episode_number, r.episode_number);
    }
  })();

  for (const r of rows) {
    try {
      db.logPipelineEvent({
        showId: r.show_id,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        stage: 'FAILED',
        eventType: 'download_failed',
        reasonCode: 'RELEASE_FAILED_BLOCKLISTED',
        message: `"${r.release_title}" failed (${reason})${input.blocklist !== false ? ' — blocklisted, will re-search' : ''}`,
        releaseTitle: r.release_title,
        indexerName: r.indexer_name ?? undefined,
      });
    } catch { /* non-fatal */ }
  }
  try {
    db.logEvent({
      type: 'error',
      entityType: 'release',
      message: `Marked "${grab.release_title}" failed (${reason})${input.blocklist !== false ? ' and blocklisted it' : ''}`,
    });
  } catch { /* non-fatal */ }

  return { failedGrabIds: rows.map(r => r.id), blocklistId };
}

/**
 * Fail every open grab of a release the download client gave up on. The
 * TorBox waiter only knows what it submitted (title + hash), so match on
 * that. Returns the number of grabs failed.
 */
export function failGrabsForRelease(
  release: { title: string; infoHash?: string | null },
  reason: string,
  source: FailureSource = 'torbox',
): number {
  const open = db.findOpenGrabsForRelease(release);
  const done = new Set<number>();
  for (const g of open) {
    if (done.has(g.id)) continue;
    const res = markReleaseFailed({ grabId: g.id, reason, source });
    for (const id of res?.failedGrabIds ?? []) done.add(id);
  }
  return done.size;
}

/** Advance every open grab of a release (TorBox downloading/completed). */
export function advanceGrabsForRelease(
  release: { title: string; infoHash?: string | null },
  status: 'downloading' | 'completed',
): void {
  for (const g of db.findOpenGrabsForRelease(release)) db.markGrabStatus(g.id, status);
}

/** Candidate filter helper for search + RSS: true = skip this release. */
export function isBlocklisted(
  showId: string,
  release: { title: string; infoHash?: string | null; magnetUrl?: string | null },
): boolean {
  try {
    return db.isBlocklisted(showId, release);
  } catch {
    return false;
  }
}

/**
 * Drop blocklisted releases from a candidate list (search path), logging one
 * aggregate pipeline event so the trace says why a release was skipped.
 */
export function dropBlocklisted<T extends { title: string; infoHash?: string | null; magnetUrl?: string | null }>(
  showId: string,
  releases: T[],
  ctx: { season?: number; episode?: number },
): T[] {
  if (releases.length === 0) return releases;
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const r of releases) {
    if (isBlocklisted(showId, r)) dropped.push(r.title);
    else kept.push(r);
  }
  if (dropped.length > 0) {
    try {
      db.logPipelineEvent({
        showId, seasonNumber: ctx.season ?? null, episodeNumber: ctx.episode ?? null,
        stage: 'SEARCHING', eventType: 'release_blocklisted', reasonCode: 'RELEASE_FAILED_BLOCKLISTED',
        message: `${dropped.length} blocklisted release(s) skipped`,
        metadata: { count: dropped.length, releases: dropped.slice(0, 20) },
      });
    } catch { /* non-fatal */ }
  }
  return kept;
}
