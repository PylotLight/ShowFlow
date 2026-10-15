// Safe activation of a staged release: drain → (backup if the release brings
// migrations) → supervisor handoff, plus rollback detection on the next boot
// and the optional auto-activate policy. All of this is app-side only — the
// supervisor protocol (/admin/activate) is unchanged, so it ships OTA.

import { db } from "../db";
import { triggerActivate } from "./updates_manager";
import { runBackup, loadRetention, DEFAULT_RETENTION } from "./backup";
import {
  waitForQuiet,
  newMigrations,
  shouldBackupBeforeActivate,
  decideAutoActivate,
  normalizeAutoActivate,
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

export type ActivationPhase = "draining" | "backing-up" | "handing-off" | "failed";

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
  const next = reconcileAttempt(getLastActivation(), BUILD_COMMIT, nowMs);
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
}

/**
 * Runs the full safe-activation sequence in the background. Returns
 * immediately: `{ ok:false }` only for "already activating"; everything after
 * that is observable through getActivationProgress() and, once the handoff
 * kills this process, through /internal/ready + the boot-time reconcile.
 */
export function startActivation(releaseId: string, opts: StartActivationOpts = {}): { ok: boolean; message: string } {
  if (progress && progress.phase !== "failed") {
    return { ok: false, message: `Activation of ${progress.tag ?? progress.releaseId} is already in progress (${progress.phase}).` };
  }
  progress = {
    releaseId,
    tag: opts.tag ?? null,
    phase: "draining",
    detail: "Waiting for running imports/scans to finish…",
    busy: [],
    startedAt: new Date().toISOString(),
    auto: !!opts.auto,
  };
  void runActivation(releaseId, opts).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    fail(releaseId, opts.tag ?? null, `Activation failed: ${message}`);
  });
  return { ok: true, message: `Activation of ${opts.tag ?? releaseId} started.` };
}

function fail(releaseId: string, tag: string | null, message: string): void {
  if (progress) progress = { ...progress, phase: "failed", detail: message, busy: [] };
  const prev = getLastActivation();
  if (prev && prev.releaseId === releaseId && !prev.outcome) {
    saveAttempt({ ...prev, outcome: "failed", message, finishedAt: new Date().toISOString() });
  } else {
    saveAttempt({ releaseId, tag, fromReleaseId: BUILD_COMMIT, startedAt: new Date().toISOString(), backupFile: null, outcome: "failed", message, finishedAt: new Date().toISOString() });
  }
  db.logEvent({ type: "error", entityType: "system", entityId: tag ?? releaseId, message });
}

async function runActivation(releaseId: string, opts: StartActivationOpts): Promise<void> {
  const tag = opts.tag ?? null;

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
        return;
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
      return;
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
  }
  // ok/timedOut: we're being replaced; the next boot reconciles.
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

/** Called from the update-check task (every 15 min) and right after staging. */
export function maybeAutoActivate(pending: { releaseId: string; tag: string } | null, now = new Date()): { activate: boolean; reason: string } {
  const decision = decideAutoActivate({
    settings: getAutoActivate(),
    now,
    pending,
    failedReleaseId: failedReleaseId(),
    busy: currentBusy(),
    activating: !!progress && progress.phase !== "failed",
  });
  if (decision.activate && pending) {
    console.log(`[updates] auto-activating ${pending.tag} (${decision.reason})`);
    startActivation(pending.releaseId, { tag: pending.tag, auto: true, drainTimeoutMs: 0 });
  }
  return decision;
}
