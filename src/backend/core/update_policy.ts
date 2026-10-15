// Pure decision logic for the in-app update flow (no db / network imports,
// so it's unit-testable in isolation). The wiring lives in
// update_activation.ts and update_watcher.ts.

// ---- Busy / drain ---------------------------------------------------------

/** Something that would be interrupted by the stop-start handoff. */
export interface BusyItem {
  kind: 'task' | 'job' | 'import';
  id: string;
  label: string;
}

/**
 * Scheduler tasks that are cheap / safe to kill mid-run. Everything else
 * (scans, syncs, backups, grabs) counts as busy. `update-check` is the task
 * that calls auto-activate itself, so it must never block it.
 */
export const NON_BLOCKING_TASKS = new Set(['update-check', 'health-check', 'watcher-monitor']);

/**
 * Background job types that block a handoff. TorBox grabs are deliberately
 * NOT here: their torrent ids persist in settings, the waiter re-attaches on
 * boot and the local fetch resumes its `.part` file via Range, so a restart
 * costs a few seconds, not the download. Image migration is resumable too.
 */
export const BLOCKING_JOB_TYPES = new Set(['library-scan', 'sonarr-import', 'backup', 'db-cleanup']);

/** In-flight download-manager states that mean files are being moved/imported right now. */
export const BLOCKING_PROCESSING_STATES = new Set(['importing']);

export function collectBusy(input: {
  runningTasks: string[];
  activeJobs: { id: string; type: string; label: string }[];
  processing: { id: string; title: string; state: string }[];
}): BusyItem[] {
  const out: BusyItem[] = [];
  for (const t of input.runningTasks) {
    if (!NON_BLOCKING_TASKS.has(t)) out.push({ kind: 'task', id: t, label: `task ${t}` });
  }
  for (const j of input.activeJobs) {
    if (BLOCKING_JOB_TYPES.has(j.type)) out.push({ kind: 'job', id: j.id, label: j.label });
  }
  for (const p of input.processing) {
    if (BLOCKING_PROCESSING_STATES.has(p.state)) out.push({ kind: 'import', id: p.id, label: `importing ${p.title}` });
  }
  return out;
}

export interface DrainResult {
  quiet: boolean;
  waitedMs: number;
  /** What was still busy when we gave up (empty when quiet). */
  busy: BusyItem[];
}

/**
 * Polls `getBusy` until nothing is busy or `timeoutMs` elapses. Never throws;
 * a probe that throws counts as "not busy" (a broken probe must not wedge
 * updates forever). `sleep`/`now` are injectable for tests.
 */
export async function waitForQuiet(
  getBusy: () => BusyItem[],
  opts: {
    timeoutMs: number;
    pollMs?: number;
    onWait?: (busy: BusyItem[], waitedMs: number) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = opts.pollMs ?? 2000;
  const start = now();
  const probe = () => {
    try { return getBusy(); } catch { return []; }
  };
  let busy = probe();
  while (busy.length > 0) {
    const waited = now() - start;
    if (waited >= opts.timeoutMs) return { quiet: false, waitedMs: waited, busy };
    opts.onWait?.(busy, waited);
    await sleep(Math.min(pollMs, Math.max(1, opts.timeoutMs - waited)));
    busy = probe();
  }
  return { quiet: true, waitedMs: now() - start, busy: [] };
}

// ---- Migrations / backup --------------------------------------------------

export interface JournalEntry { idx: number; when: number; tag: string }

/**
 * Migrations the candidate release would apply on boot. Mirrors drizzle's own
 * migrator rule: anything whose journal `when` is newer than the newest
 * applied `created_at` in __drizzle_migrations. Returns null when the target
 * journal couldn't be read (unknown — treat as "has migrations").
 */
export function newMigrations(targetJournal: { entries?: JournalEntry[] } | null, lastAppliedAt: number | null): JournalEntry[] | null {
  if (!targetJournal || !Array.isArray(targetJournal.entries)) return null;
  const floor = lastAppliedAt ?? -Infinity;
  return targetJournal.entries.filter((e) => typeof e.when === 'number' && e.when > floor);
}

/** Back up when the release brings new migrations, or when we can't tell. */
export function shouldBackupBeforeActivate(pending: JournalEntry[] | null): boolean {
  return pending === null || pending.length > 0;
}

// ---- Auto-activate --------------------------------------------------------

export type AutoActivateMode = 'off' | 'idle' | 'window';

export interface AutoActivateSettings {
  mode: AutoActivateMode;
  /** Server-local hour (0-23) for `window` mode. */
  hour: number;
}

export const DEFAULT_AUTO_ACTIVATE: AutoActivateSettings = { mode: 'off', hour: 4 };

export function normalizeAutoActivate(raw: unknown): AutoActivateSettings {
  let v: any = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  const mode: AutoActivateMode = v && (v.mode === 'idle' || v.mode === 'window') ? v.mode : 'off';
  const h = Number(v?.hour);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_AUTO_ACTIVATE.hour;
  return { mode, hour };
}

export interface AutoActivateInput {
  settings: AutoActivateSettings;
  now: Date;
  pending: { releaseId: string } | null;
  /** releaseId of an earlier attempt that failed or rolled back. */
  failedReleaseId: string | null;
  busy: BusyItem[];
  /** An activation is already being prepared. */
  activating: boolean;
}

export function decideAutoActivate(i: AutoActivateInput): { activate: boolean; reason: string } {
  if (i.settings.mode === 'off') return { activate: false, reason: 'auto-activate is off' };
  if (!i.pending) return { activate: false, reason: 'nothing staged' };
  if (i.activating) return { activate: false, reason: 'activation already in progress' };
  if (i.failedReleaseId && i.failedReleaseId === i.pending.releaseId) {
    return { activate: false, reason: 'this release already failed to activate — activate it manually' };
  }
  if (i.settings.mode === 'window' && i.now.getHours() !== i.settings.hour) {
    return { activate: false, reason: `outside the ${String(i.settings.hour).padStart(2, '0')}:00 window` };
  }
  if (i.busy.length > 0) return { activate: false, reason: `busy: ${i.busy.map((b) => b.label).join(', ')}` };
  return { activate: true, reason: i.settings.mode === 'idle' ? 'idle' : 'in window and idle' };
}

// ---- Rollback detection ---------------------------------------------------

export interface ActivationAttempt {
  releaseId: string;
  tag: string | null;
  fromReleaseId: string;
  startedAt: string;
  backupFile: string | null;
  outcome?: 'activated' | 'rolled-back' | 'failed';
  message?: string;
  finishedAt?: string;
}

/** How long after an attempt a boot is still considered its outcome. */
export const ATTEMPT_RECONCILE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Called on boot with the last recorded attempt: if we're now running the
 * target, it worked; if we're still on (or back on) another build within the
 * window, the supervisor's readiness gate failed and it relaunched
 * lastKnownGood. Returns null when there's nothing to reconcile.
 */
export function reconcileAttempt(attempt: ActivationAttempt | null, runningReleaseId: string, nowMs: number): ActivationAttempt | null {
  if (!attempt || attempt.outcome) return null;
  const started = Date.parse(attempt.startedAt);
  if (Number.isFinite(started) && nowMs - started > ATTEMPT_RECONCILE_WINDOW_MS) return null;
  const finishedAt = new Date(nowMs).toISOString();
  if (runningReleaseId === attempt.releaseId) {
    return { ...attempt, outcome: 'activated', finishedAt, message: `Release ${attempt.tag ?? attempt.releaseId} is active.` };
  }
  const restore = attempt.backupFile ? ` A pre-update backup (${attempt.backupFile}) is available under Backups if the new release migrated the database.` : '';
  return {
    ...attempt,
    outcome: 'rolled-back',
    finishedAt,
    message: `Release ${attempt.tag ?? attempt.releaseId} failed its health checks — the supervisor rolled back to the previous build.${restore}`,
  };
}

// ---- Download retry backoff -----------------------------------------------

/**
 * Delay before retrying a failed auto-download of the same tag. The common
 * case is "tag published, CI still uploading the tarball", so start short
 * (1 min) and back off to the normal 15 min cadence.
 */
export function retryDelayMs(failures: number): number {
  const steps = [60_000, 120_000, 300_000, 600_000];
  return steps[Math.max(0, failures - 1)] ?? 15 * 60_000;
}
