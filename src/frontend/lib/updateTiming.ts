// Timing helpers for the Updates panel's apply/reconnect flow. Pure so they
// can be unit-tested without React.

/**
 * Delay before reconnect poll #n (0-based) while the supervisor swaps builds.
 * Starts at 500ms and backs off ×1.25 to a 2s cap (was 800ms ×1.4 → 4s, which
 * could leave the page waiting up to ~4s after the new build was already up).
 * ±10% jitter so several open tabs don't poll in lockstep.
 */
export function reconnectDelayMs(n: number, random: () => number = Math.random): number {
  const base = Math.min(500 * Math.pow(1.25, Math.max(0, n)), 2_000);
  return Math.round(base * (0.9 + 0.2 * random()));
}

/** /pending poll interval: fast while a handoff is imminent, relaxed otherwise. */
export function pendingPollMs(awaitingHandoff: boolean): number {
  return awaitingHandoff ? 500 : 1_500;
}

export interface ActivationRecord {
  outcome?: "activated" | "rolled-back" | "failed";
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Seconds the last successful handoff took (attempt recorded just before the
 * supervisor handoff → reconciled on the new build's boot), or null when there
 * is no trustworthy sample. Used for "applying takes ~Ns".
 */
export function lastApplySeconds(last: ActivationRecord | null | undefined): number | null {
  if (!last || last.outcome !== "activated" || !last.startedAt || !last.finishedAt) return null;
  const ms = Date.parse(last.finishedAt) - Date.parse(last.startedAt);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 5 * 60_000) return null;
  return Math.max(1, Math.round(ms / 1000));
}

/** Short human label for the staged banner. */
export function applyEstimateLabel(last: ActivationRecord | null | undefined, hasMigrations: boolean): string {
  const s = lastApplySeconds(last);
  const base = s !== null ? `Applying takes ~${s}s (last update)` : "Applying usually takes a few seconds";
  return hasMigrations ? `${base}, plus a quick database backup` : base;
}
