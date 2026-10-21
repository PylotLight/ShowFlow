// "Instant" update: one click runs download → verify → activate (drain,
// backup if the release migrates, supervisor handoff, rollback on a failed
// health check). The panel follows it through /pending and reconnects.
//
// The flow holds the update job slot from the click to the handoff (see
// update_jobs.ts), so a background auto-activate can't restart ShowFlow
// between its download and its activation, and a second click (or a second
// tab) joins the running flow instead of starting another.

import type { InstantJob, JobSource, UpdateCoordinator } from "./update_jobs";
import { UpdateBusyError } from "./update_jobs";
import type { StageResult } from "./updates_manager";
import type { ActivationOutcome } from "./update_activation";

/** Instant updates wait this long for imports/scans before activating anyway (same as a manual Activate). */
export const INSTANT_DRAIN_TIMEOUT_MS = 2 * 60_000;

export interface InstantTarget {
  githubReleaseId: number;
  tag?: string | null;
}

export interface InstantDeps {
  jobs: UpdateCoordinator<StageResult>;
  /** Download + verify (joins a running download of the same release). */
  download: (githubReleaseId: number) => Promise<StageResult & { tag?: string }>;
  /** Remember the verified release as the staged one. */
  recordStaged: (tag: string, releaseId: string) => Promise<unknown>;
  /** Kick off the drain → backup → handoff sequence. */
  activate: (releaseId: string, tag: string | null) => { ok: boolean; message: string; done?: Promise<ActivationOutcome> };
  log?: (type: "update" | "error", message: string) => void;
}

export interface InstantStart {
  ok: boolean;
  message: string;
  /** Joined an instant update of the same release that was already running. */
  joined?: boolean;
  /** Resolves when the flow has handed off or stopped (for tests / logging). */
  done?: Promise<InstantJob | null>;
}

/**
 * Starts an instant update in the background. Returns at once: 409-style
 * `{ ok:false }` only when a different update holds the slot.
 */
export function startInstantUpdate(target: InstantTarget, source: JobSource, deps: InstantDeps): InstantStart {
  const tag = target.tag ?? null;
  const act = deps.jobs.currentActivation();
  if (act && !(tag && act.tag === tag)) {
    return { ok: false, message: `ShowFlow is already activating ${act.tag ?? act.releaseId}.` };
  }
  const claim = deps.jobs.beginInstant({ tag }, source);
  if (!claim) {
    const cur = deps.jobs.currentInstant();
    return { ok: false, message: `An update to ${cur?.tag ?? "another release"} is already running.` };
  }
  if (claim.joined) return { ok: true, joined: true, message: `Update to ${tag ?? "this release"} is already running.` };
  if (act) {
    // Same release is already activating (e.g. auto-activate got there first): follow it.
    deps.jobs.updateInstant({ step: "activate", releaseId: act.releaseId });
    return { ok: true, joined: true, message: `${tag} is already being activated.` };
  }
  const done = runInstant(target, deps);
  return { ok: true, message: `Updating to ${tag ?? "the selected release"}…`, done };
}

async function runInstant(target: InstantTarget, deps: InstantDeps): Promise<InstantJob | null> {
  const { jobs } = deps;
  const fail = (message: string) => {
    jobs.updateInstant({ step: "failed", message });
    deps.log?.("error", `Instant update failed: ${message}`);
    return jobs.snapshot().instant;
  };
  try {
    // 1+2. Download + verify (or join the watcher's download of it).
    let res: StageResult & { tag?: string };
    try {
      res = await deps.download(target.githubReleaseId);
    } catch (err) {
      if (err instanceof UpdateBusyError) {
        // Someone activated in between. If it's this release, follow that.
        if (target.tag && err.activation.tag === target.tag) {
          jobs.updateInstant({ step: "activate", releaseId: err.activation.releaseId });
          return jobs.snapshot().instant;
        }
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
    const tag = res.tag ?? target.tag ?? null;
    if (tag) jobs.updateInstant({ tag });
    if (res.alreadyActive) {
      jobs.updateInstant({ step: "done", releaseId: res.releaseId ?? null, message: res.message });
      return jobs.snapshot().instant;
    }
    if (!res.ok || !res.releaseId) return fail(res.message || "Download failed");
    jobs.updateInstant({ releaseId: res.releaseId });
    if (tag) await deps.recordStaged(tag, res.releaseId).catch(() => {});

    // 3. Activate: drain (waits up to 2 min for imports/scans, then goes),
    //    backup if the release migrates, handoff. The supervisor verifies the
    //    manifest + sha again and rolls back on a failed health check.
    const started = deps.activate(res.releaseId, tag);
    if (!started.ok) {
      // Another activation won the slot. Same release: just follow it.
      const act = jobs.currentActivation();
      if (act && act.releaseId === res.releaseId) {
        jobs.updateInstant({ step: "activate" });
        return jobs.snapshot().instant;
      }
      return fail(started.message);
    }
    jobs.updateInstant({ step: "activate", message: null });
    deps.log?.("update", `Instant update: ${tag ?? res.releaseId} downloaded & verified, activating`);
    const outcome = await (started.done ?? Promise.resolve<ActivationOutcome>("handed-off"));
    if (outcome === "handed-off") return jobs.snapshot().instant; // we're being replaced
    if (outcome === "failed") return fail("Activation failed, see the update status for details.");
    // postponed / cancelled don't happen for a manual activation, but don't leave the slot held.
    jobs.updateInstant({ step: "done", message: `Activation ${outcome}; ${tag ?? "the release"} is staged.` });
    return jobs.snapshot().instant;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
