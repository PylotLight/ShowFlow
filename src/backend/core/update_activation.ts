// Safe activation of a staged release: drain → (backup if the release brings
// migrations) → supervisor handoff, plus rollback detection on the next boot
// and the optional auto-activate policy. All of this is app-side only — the
// supervisor protocol (/admin/activate) is unchanged, so it ships OTA.

import { readFileSync, existsSync } from "node:fs";
import { db } from "../db";
import { triggerActivate, updateJobs } from "./updates_manager";
import { runBackup, loadRetention, DEFAULT_RETENTION } from "./backup";
import {
  waitForQuiet,
  newMigrations,
  shouldBackupBeforeActivate,
  decideAutoActivate,
  normalizeAutoActivate,
  normalizeUpdateMode,
  effectiveAutoActivate,
  type UpdateMode,
  reconcileAttempt,
  type BusyItem,
  type ActivationAttempt,
  type AutoActivateSettings,
  type JournalEntry,
} from "./update_policy";

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "development";

const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";
const ATTEMPT_KEY = "updates:lastActivation";
const AUTO_ACTIVATE_KEY = "updates:autoActivate";
const UPDATE_MODE_KEY = "updates:mode";

/** Manual activation waits this long for imports/scans to finish before going anyway. */
export const MANUAL_DRAIN_TIMEOUT_MS = 2 * 60_000;

// ---- Busy probe (wired from server.ts, which owns scheduler + watcher) ----

let busyProbe: () => BusyItem[] = () => [];

export function setBusyProbe(fn: () => BusyItem[]): void {
  busyProbe = fn;
}

export function currentBusy(): BusyItem[] {
  try { return busyProbe(); } catch { return []; }
}

// ---- Live progress (polled via /api/admin/updates/pending) ---------------

export type ActivationPhase = "waiting-download" | "draining" | "backing-up" | "handing-off" | "failed";

export interface ActivationProgress {
  releaseId: string;
  tag: string | null;
  phase: ActivationPhase;
  detail: string;
  busy: string[];
  startedAt: string;
  auto: boolean;
}

let progress: ActivationProgress | null = null;

export function getActivationProgress(): ActivationProgress | null {
  return progress;
}

// ---- Attempt record (survives the restart; read on next boot) -----------

export function getLastActivation(): ActivationAttempt | null {
  const raw = db.getSetting(ATTEMPT_KEY);
  if (!raw) return null;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v.releaseId === "string" ? (v as ActivationAttempt) : null;
  } catch {
    return null;
  }
}

function saveAttempt(a: ActivationAttempt): void {
  db.setSetting(ATTEMPT_KEY, a);
}

/** releaseId of the last attempt that failed/rolled back (blocks auto-activate of the same build). */
export function failedReleaseId(): string | null {
  const a = getLastActivation();
  return a && (a.outcome === "rolled-back" || a.outcome === "failed") ? a.releaseId : null;
}

/**
 * Boot-time: decide what happened to the last attempt. Returns the
 * reconciled record (or null) so the caller can log/notify.
 */
export function reconcileActivationOnBoot(nowMs = Date.now()): ActivationAttempt | null {
  const last = getLastActivation();
  const next = reconcileAttempt(last, runningReleaseIdFor(last?.releaseId ?? null), nowMs);
  if (!next) return null;
  saveAttempt(next);
  db.logEvent({
    type: next.outcome === "activated" ? "update" : "error",
    entityType: "system",
    entityId: next.tag ?? next.releaseId,
    message: next.message ?? `Activation ${next.outcome}`,
  });
  console.log(`[updates] last activation ${next.outcome}: ${next.message}`);
  return next;
}

/**
 * Our release dir id. Normally BUILD_COMMIT, but the attempt is keyed by the
 * tarball sha, and a mis-stamped build (v0.1.81 baked in the pre-bump
 * commit) never equals it — so also accept the target dir whose manifest
 * commit is ours, instead of reporting a bogus rollback.
 */
function runningReleaseIdFor(target: string | null): string {
  if (!target || target === BUILD_COMMIT || BUILD_COMMIT === "development" || /[/.]/.test(target)) return BUILD_COMMIT;
  try {
    const m = JSON.parse(readFileSync(`${DATA_DIR}/releases/${target}/manifest.json`, "utf8")) as { commit?: string };
    return m.commit === BUILD_COMMIT ? target : BUILD_COMMIT;
  } catch {
    return BUILD_COMMIT;
  }
}

// ---- Migration check -----------------------------------------------------

function lastAppliedMigrationAt(): number | null {
  try {
    const row = db.db.query("SELECT max(created_at) AS m FROM __drizzle_migrations").get() as { m: number | string | null } | null;
    const n = Number(row?.m);
    return Number.isFinite(n) && row?.m !== null ? n : null;
  } catch {
    return null;
  }
}

/** Migrations the staged release would apply, or null when its journal is unreadable. */
export async function pendingMigrationsFor(releaseId: string): Promise<JournalEntry[] | null> {
  const file = Bun.file(`${DATA_DIR}/releases/${releaseId}/migrations/meta/_journal.json`);
  let journal: { entries?: JournalEntry[] } | null = null;
  try {
    if (await file.exists()) journal = await file.json();
  } catch {
    journal = null;
  }
  return newMigrations(journal, lastAppliedMigrationAt());
}

// ---- Orchestration -------------------------------------------------------

export interface StartActivationOpts {
  tag?: string | null;
  auto?: boolean;
  /** Skip the drain wait (user clicked "activate now anyway"). */
  force?: boolean;
  drainTimeoutMs?: number;
  /**
   * Re-checked after waiting out an in-flight download: auto-activate drops
   * out when the release it meant to apply is no longer the staged one.
   */
  stillWanted?: () => boolean;
}

export type ActivationOutcome = "handed-off" | "failed" | "postponed" | "cancelled";

/**
 * Runs the full safe-activation sequence in the background. Returns
 * immediately: `{ ok:false }` only for "already activating"; everything after
 * that is observable through getActivationProgress() and, once the handoff
 * kills this process, through /internal/ready + the boot-time reconcile.
 * `done` settles with how it ended (the instant-update flow waits on it).
 */
export function startActivation(
  releaseId: string,
  opts: StartActivationOpts = {},
): { ok: boolean; message: string; done?: Promise<ActivationOutcome> } {
  const tag = opts.tag ?? null;
  // The job slot is the one gate: one activation at a time, and while it's
  // held no new download can start (see update_jobs.ts).
  if (!updateJobs.beginActivation({ releaseId, tag, source: opts.auto ? "auto" : "manual" })) {
    const cur = updateJobs.currentActivation();
    const label = progress?.tag ?? progress?.releaseId ?? cur?.tag ?? cur?.releaseId ?? "a release";
    return { ok: false, message: `Activation of ${label} is already in progress${progress ? ` (${progress.phase})` : ""}.` };
  }
  const dl = updateJobs.currentDownload();
  progress = {
    releaseId,
    tag,
    phase: dl ? "waiting-download" : "draining",
    detail: dl
      ? `Waiting for the download of ${dl.tag ?? dl.releaseId?.slice(0, 12) ?? "a release"} to finish…`
      : "Waiting for running imports/scans to finish…",
    busy: [],
    startedAt: new Date().toISOString(),
    auto: !!opts.auto,
  };
  const done = runActivation(releaseId, opts)
    .catch((err): ActivationOutcome => {
      const message = err instanceof Error ? err.message : String(err);
      fail(releaseId, tag, `Activation failed: ${message}`);
      return "failed";
    })
    .then((outcome) => {
      // Anything short of a handoff gives the slot back. After a handoff this
      // process is about to be replaced, so keep it (no new downloads).
      if (outcome !== "handed-off") updateJobs.endActivation(releaseId);
      return outcome;
    });
  return { ok: true, message: `Activation of ${tag ?? releaseId} started.`, done };
}

function fail(releaseId: string, tag: string | null, message: string): void {
  updateJobs.endActivation(releaseId);
  if (progress) progress = { ...progress, phase: "failed", detail: message, busy: [] };
  const prev = getLastActivation();
  if (prev && prev.releaseId === releaseId && !prev.outcome) {
    saveAttempt({ ...prev, outcome: "failed", message, finishedAt: new Date().toISOString() });
  } else {
    saveAttempt({ releaseId, tag, fromReleaseId: BUILD_COMMIT, startedAt: new Date().toISOString(), backupFile: null, outcome: "failed", message, finishedAt: new Date().toISOString() });
  }
  db.logEvent({ type: "error", entityType: "system", entityId: tag ?? releaseId, message });
}

async function runActivation(releaseId: string, opts: StartActivationOpts): Promise<ActivationOutcome> {
  const tag = opts.tag ?? null;

  // 0. Never restart under a running download/verify (the watcher's, or a
  //    manual "Update to" from another tab): let it finish first.
  if (updateJobs.currentDownload()) {
    await updateJobs.waitForDownloads();
    if (opts.stillWanted && !opts.stillWanted()) {
      progress = null;
      console.log(`[updates] auto-activate of ${tag ?? releaseId} dropped: a newer download replaced it`);
      return "cancelled";
    }
    if (progress) progress = { ...progress, phase: "draining", detail: "Waiting for running imports/scans to finish…" };
  }

  // 1. Drain: let imports / scans / backups finish so the SIGTERM doesn't
  //    cut a file move in half. Auto mode only fires when already idle, so
  //    this is effectively instant there.
  if (!opts.force) {
    const drain = await waitForQuiet(currentBusy, {
      timeoutMs: opts.drainTimeoutMs ?? MANUAL_DRAIN_TIMEOUT_MS,
      onWait: (busy, waited) => {
        if (progress) {
          progress = {
            ...progress,
            busy: busy.map((b) => b.label),
            detail: `Waiting for ${busy.length} running job${busy.length === 1 ? "" : "s"} to finish (${Math.round(waited / 1000)}s)…`,
          };
        }
      },
    });
    if (!drain.quiet) {
      if (opts.auto) {
        // Never interrupt work on the user's behalf — try again next tick.
        progress = null;
        console.log(`[updates] auto-activate postponed, still busy: ${drain.busy.map((b) => b.label).join(", ")}`);
        return "postponed";
      }
      db.logEvent({
        type: "update",
        entityType: "system",
        entityId: tag ?? releaseId,
        message: `Activating ${tag ?? releaseId} after ${Math.round(drain.waitedMs / 1000)}s drain; still running: ${drain.busy.map((b) => b.label).join(", ")}`,
      });
    }
  }

  // 2. Backup when the new release migrates the schema (or we can't tell).
  //    Rolling back to lastKnownGood after a destructive migration would
  //    otherwise leave the old build on a newer schema with no way back.
  let backupFile: string | null = null;
  const migrations = await pendingMigrationsFor(releaseId);
  if (shouldBackupBeforeActivate(migrations)) {
    progress = progress && {
      ...progress,
      phase: "backing-up",
      busy: [],
      detail: migrations
        ? `Backing up the database — ${migrations.length} new migration${migrations.length === 1 ? "" : "s"} (${migrations.map((m) => m.tag).join(", ")})…`
        : "Backing up the database (couldn't read the release's migration list)…",
    };
    let retention = DEFAULT_RETENTION;
    try { retention = loadRetention((k) => db.getSetting(k)); } catch {}
    try {
      const result = await runBackup("backups", retention, db.imagesDir);
      backupFile = result.dbFile.split("/").pop() ?? result.dbFile;
      db.logEvent({ type: "update", entityType: "system", entityId: tag ?? releaseId, message: `Pre-update backup ${backupFile} taken before activating ${tag ?? releaseId}` });
    } catch (err) {
      // No backup → don't migrate. The user can still force it from the CLI.
      const message = err instanceof Error ? err.message : String(err);
      fail(releaseId, tag, `Pre-update backup failed (${message}) — not activating ${tag ?? releaseId}.`);
      return "failed";
    }
  }

  // 3. Record the attempt BEFORE the handoff — this process dies during it,
  //    and the next boot (new build or rolled-back old one) reads this to
  //    know whether it worked.
  saveAttempt({ releaseId, tag, fromReleaseId: BUILD_COMMIT, startedAt: new Date().toISOString(), backupFile });
  progress = progress && { ...progress, phase: "handing-off", busy: [], detail: "Handing off to the supervisor — ShowFlow restarts now." };
  db.logEvent({ type: "update", entityType: "system", entityId: tag ?? releaseId, message: `Activation ${opts.auto ? "(auto) " : ""}handed off for release "${releaseId}"` });

  const result = await triggerActivate(releaseId);
  if (!result.ok) {
    // Pre-flight rejection (checksum, supervisor too old, already activating).
    fail(releaseId, tag, result.message);
    return "failed";
  }
  // ok/timedOut: we're being replaced; the next boot reconciles.
  return "handed-off";
}

// ---- Auto-activate -------------------------------------------------------

export function getAutoActivate(): AutoActivateSettings {
  return normalizeAutoActivate(db.getSetting(AUTO_ACTIVATE_KEY));
}

export function setAutoActivate(s: AutoActivateSettings): AutoActivateSettings {
  const n = normalizeAutoActivate(s);
  db.setSetting(AUTO_ACTIVATE_KEY, n);
  return n;
}

export function getUpdateMode(): UpdateMode {
  return normalizeUpdateMode(db.getSetting(UPDATE_MODE_KEY));
}

export function setUpdateMode(mode: unknown): UpdateMode {
  const n = normalizeUpdateMode(mode);
  db.setSetting(UPDATE_MODE_KEY, n);
  return n;
}

/** Called from the update-check task (every 15 min) and right after staging. */
export function maybeAutoActivate(pending: { releaseId: string; tag: string } | null, now = new Date()): { activate: boolean; reason: string } {
  const mode = getUpdateMode();
  const decision = decideAutoActivate({
    settings: effectiveAutoActivate(mode, getAutoActivate()),
    now,
    pending,
    failedReleaseId: failedReleaseId(),
    busy: currentBusy(),
    activating: updateJobs.phase() === "activating" || (!!progress && progress.phase !== "failed"),
    downloading: updateJobs.downloadBusy(),
  });
  if (decision.activate && pending) {
    console.log(`[updates] auto-activating ${pending.tag} (${mode === "instant" ? "instant mode, " : ""}${decision.reason})`);
    startActivation(pending.releaseId, {
      tag: pending.tag,
      auto: true,
      drainTimeoutMs: 0,
      stillWanted: () => stagedReleaseId() === pending.releaseId,
    });
  }
  return decision;
}

/** releaseId of the currently staged (pending) release, read fresh from settings. */
function stagedReleaseId(): string | null {
  const raw = db.getSetting("updates:pending");
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v.releaseId === "string" ? v.releaseId : null;
  } catch {
    return null;
  }
}

// ---- Instant update (download → verify → activate in one go) -------------

/**
 * True when `releaseId` is already downloaded + verified into the
 * supervisor's releases dir as the staged release (and didn't just fail to
 * activate, in which case a fresh download is the sensible retry).
 */
export function isAlreadyStaged(releaseId: string, pendingReleaseId: string | null): boolean {
  if (!pendingReleaseId || pendingReleaseId !== releaseId) return false;
  if (failedReleaseId() === releaseId) return false;
  if (/[/.]/.test(releaseId)) return false;
  return existsSync(`${DATA_DIR}/releases/${releaseId}/manifest.json`);
}

/** Starts an instant update of a GitHub release (Settings > Updates "Update now"). */
export async function startInstantUpdateFor(githubReleaseId: number, tag: string | null, source: "manual" | "auto" = "manual") {
  const [{ startInstantUpdate, INSTANT_DRAIN_TIMEOUT_MS }, { downloadAndInstall }, watcher] = await Promise.all([
    import("./update_instant"),
    import("./updates_manager"),
    import("./update_watcher"),
  ]);
  return startInstantUpdate({ githubReleaseId, tag }, source, {
    jobs: updateJobs,
    download: (id) => downloadAndInstall(id, { isStaged: (rid) => isAlreadyStaged(rid, watcher.getPendingUpdate()?.releaseId ?? null) }),
    recordStaged: (t, rid) => watcher.recordStaged({ tag: t, releaseId: rid }),
    activate: (rid, t) => startActivation(rid, { tag: t, auto: source === "auto", drainTimeoutMs: INSTANT_DRAIN_TIMEOUT_MS }),
    activationError: () => (progress?.phase === "failed" ? progress.detail : getLastActivation()?.message ?? null),
    log: (type, message) => db.logEvent({ type, entityType: "system", entityId: tag ?? undefined, message }),
  });
}
