// Pure decision logic for the in-app update flow (no db / network imports,
// so it's unit-testable in isolation). The wiring lives in
// update_activation.ts and update_watcher.ts.

// ---- Versions / prereleases ------------------------------------------------

interface Semver { core: number[]; pre: string[] }

/** `v1.2.3-rc.1+build` -> { core: [1,2,3], pre: ['rc','1'] }. null if the core isn't numeric. */
export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(v.trim());
  if (!m) return null;
  return { core: m[1]!.split('.').map(Number), pre: m[2] ? m[2].split('.') : [] };
}

/** True for tags like `v0.1.80-test.1` / `v1.0.0-rc1` (anything with a semver prerelease suffix). */
export function isPrereleaseTag(tag: string): boolean {
  const p = parseSemver(tag);
  return !!p && p.pre.length > 0;
}

/**
 * semver precedence: numeric core first, then a version WITH a prerelease
 * suffix sorts below the same version without one (`0.1.80-test.1` < `0.1.80`),
 * prerelease identifiers compare numerically when both are numbers, else
 * lexically, and a shorter identifier list wins ties. Build metadata is
 * ignored. Returns null when either side isn't a version (e.g. "development").
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length; // release > prerelease
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    if (!Number.isNaN(nx)) return -1; // numeric ids sort below alphanumeric
    if (!Number.isNaN(ny)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ---- What we're running ------------------------------------------------------

/** True when `v` is a real release version (`v0.1.81`), not "main"/"development". */
export function isReleaseVersion(v: string | null | undefined): v is string {
  return typeof v === 'string' && parseSemver(v) !== null;
}

/**
 * The version we're actually on. The compiled-in BUILD_VERSION wins when it's
 * a real version; a bad stamp ("main" — v0.1.81 shipped like that) falls back
 * to the active release's manifest, then the tag recorded when that release
 * was activated. null = unknown (treat as a dev build: never auto-update).
 */
export function resolveCurrentVersion(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) if (isReleaseVersion(c)) return c;
  return null;
}

export type ReleaseRelation = 'current' | 'newer' | 'older' | 'unknown';

/**
 * Where a listed release sits relative to what's running. Same sha as the
 * active release = current, whatever its tag says (that's the ETXTBSY guard:
 * the running binary is never offered as an update). Otherwise semver vs the
 * resolved current version; unknown when we can't tell.
 */
export function releaseRelation(
  tag: string,
  assetReleaseId: string | null,
  current: { version: string | null; releaseId: string | null },
): ReleaseRelation {
  if (assetReleaseId && current.releaseId && assetReleaseId === current.releaseId) return 'current';
  if (!current.version) return 'unknown';
  const cmp = compareSemver(tag, current.version);
  if (cmp === null) return 'unknown';
  return cmp === 0 ? 'current' : cmp > 0 ? 'newer' : 'older';
}

/** Newest entry the watcher may auto-download: skips prerelease-suffixed tags
 *  (the atom feed has no prerelease/draft flag, so the tag is the signal; drafts
 *  never show up in the feed at all). */
export function latestStableEntry<T extends { tag: string }>(list: T[]): T | undefined {
  return list.find((e) => !isPrereleaseTag(e.tag));
}

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
  // 500ms: the handoff starts within half a second of the last job finishing
  // (was 2s). An idle server never sleeps at all — the loop is skipped.
  const pollMs = opts.pollMs ?? 500;
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

// ---- Update mode -----------------------------------------------------------

/**
 * `staged` (default, the behaviour up to v0.1.89): "Update to vX" downloads +
 * verifies, then activation is a separate click or the Auto-activate policy.
 * `instant`: "Update now" runs download → verify → activate → reconnect in one
 * go, and a background auto-download activates as soon as ShowFlow is idle.
 */
export type UpdateMode = 'staged' | 'instant';

export const DEFAULT_UPDATE_MODE: UpdateMode = 'staged';

export function normalizeUpdateMode(raw: unknown): UpdateMode {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* bare string */ }
  }
  return v === 'instant' ? 'instant' : DEFAULT_UPDATE_MODE;
}

/**
 * Auto-activate policy actually in force. Instant mode means "apply as soon
 * as it's downloaded and nothing is importing/scanning", whatever the
 * staged-mode Auto-activate select says (that choice is kept for when the
 * user switches back).
 */
export function effectiveAutoActivate(mode: UpdateMode, settings: AutoActivateSettings): AutoActivateSettings {
  return mode === 'instant' ? { mode: 'idle', hour: settings.hour } : settings;
}

export interface AutoActivateInput {
  settings: AutoActivateSettings;
  now: Date;
  pending: { releaseId: string; tag?: string | null } | null;
  /** releaseId of an earlier attempt that failed or rolled back. */
  failedReleaseId: string | null;
  busy: BusyItem[];
  /** An activation is already being prepared. */
  activating: boolean;
  /**
   * A download (manual or background) or an instant update is in flight.
   * Activating now would restart ShowFlow under it, so wait for it (the
   * watcher re-checks right after staging, the scheduler every 15 min).
   */
  downloading?: boolean;
}

export function decideAutoActivate(i: AutoActivateInput): { activate: boolean; reason: string } {
  if (i.settings.mode === 'off') return { activate: false, reason: 'auto-activate is off' };
  if (!i.pending) return { activate: false, reason: 'nothing staged' };
  if (i.pending.tag && isPrereleaseTag(i.pending.tag)) {
    return { activate: false, reason: 'prerelease builds are never auto-activated — activate it manually' };
  }
  if (i.activating) return { activate: false, reason: 'activation already in progress' };
  if (i.downloading) return { activate: false, reason: 'an update download is still running' };
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
