/**
 * Decides when a TorBox torrent is a lost cause, so the grab can be failed
 * and blocklisted instead of hogging a download slot until the waiter's
 * ~3h poll cap (or forever re-grabbing the same dead release).
 *
 *   - error / failed state            -> fail immediately
 *   - "stalled" for STALLED_FAIL_MS    -> fail (brief stalls recover; TorBox
 *                                         reports stalledDL while it hunts peers)
 *   - no progress for NO_PROGRESS_FAIL_MS while not complete -> fail as dead
 *     (metaDL / 0-seed torrents that never move)
 */
export const STALLED_FAIL_MS = 15 * 60 * 1000;
export const NO_PROGRESS_FAIL_MS = 90 * 60 * 1000;

export type TorrentVerdict = { failed: false } | { failed: true; reason: string };

export class TorrentHealthTracker {
  private stalledSince: number | null = null;
  private lastProgress = -1;
  private lastProgressAt: number | null = null;

  constructor(
    private readonly stalledFailMs = STALLED_FAIL_MS,
    private readonly noProgressFailMs = NO_PROGRESS_FAIL_MS,
  ) {}

  /** Feed one status poll. `progress` is 0-100 or null when unknown. */
  observe(rawState: string, progress: number | null, nowMs: number): TorrentVerdict {
    const state = rawState.toLowerCase();
    if (state.includes('error') || state.includes('fail')) {
      return { failed: true, reason: `TorBox state "${rawState}"` };
    }

    if (state.includes('stalled')) {
      this.stalledSince ??= nowMs;
      if (nowMs - this.stalledSince >= this.stalledFailMs) {
        return { failed: true, reason: `stalled for ${Math.round((nowMs - this.stalledSince) / 60000)}m (TorBox state "${rawState}")` };
      }
    } else {
      this.stalledSince = null;
    }

    const p = progress ?? -1;
    if (this.lastProgressAt == null || p > this.lastProgress) {
      this.lastProgress = p;
      this.lastProgressAt = nowMs;
    } else if (nowMs - this.lastProgressAt >= this.noProgressFailMs) {
      return { failed: true, reason: `dead: no progress for ${Math.round((nowMs - this.lastProgressAt) / 60000)}m (stuck at ${p < 0 ? '?' : p}%, state "${rawState || 'unknown'}")` };
    }
    return { failed: false };
  }
}
