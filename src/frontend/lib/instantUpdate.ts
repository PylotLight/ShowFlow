// Maps the server's instant-update job (from /api/admin/updates/pending,
// `job.instant`) to what the Updates panel's stepper should show. Pure, so
// it's unit-tested without React.

import { sameVersion } from "./updateFetch";

export interface InstantJobView {
  tag: string | null;
  releaseId: string | null;
  source: "manual" | "auto";
  step: "download" | "activate" | "failed" | "done";
  message: string | null;
  startedAt?: string;
}

export interface ActivationView {
  releaseId: string;
  tag: string | null;
  phase: string;
  detail?: string;
}

export interface LastActivationView {
  releaseId: string;
  tag: string | null;
  outcome?: "activated" | "rolled-back" | "failed";
  message?: string;
  startedAt?: string;
}

export type InstantStepState =
  /** Step 2: downloading / verifying (progress comes from `download`). */
  | { kind: "download" }
  /** Step 3: downloaded + verified, activation running; follow it by releaseId. */
  | { kind: "activate"; releaseId: string }
  | { kind: "failed"; message: string }
  /** Nothing to do (e.g. already running that release). */
  | { kind: "done"; message: string }
  /** The new build is already running it (the restart happened between polls). */
  | { kind: "applied" }
  /** No conclusive server state yet. */
  | { kind: "waiting" };

export function instantStepView(
  tag: string,
  job: InstantJobView | null,
  activation: ActivationView | null,
  lastActivation: LastActivationView | null = null,
): InstantStepState {
  if (job && sameVersion(job.tag, tag)) {
    switch (job.step) {
      case "download":
        return { kind: "download" };
      case "activate":
        if (job.releaseId) return { kind: "activate", releaseId: job.releaseId };
        break;
      case "failed":
        return { kind: "failed", message: job.message || "Update failed." };
      case "done":
        return { kind: "done", message: job.message || "Nothing to update." };
    }
  }
  // The job record may be gone (it lingers ~1 min after ending) or not show
  // the release yet: an activation of this tag is still the answer.
  if (activation && sameVersion(activation.tag, tag)) {
    if (activation.phase === "failed") return { kind: "failed", message: activation.detail || "Activation failed." };
    return { kind: "activate", releaseId: activation.releaseId };
  }
  // Download, verify and handoff can all land between two polls (small
  // release, inline extraction, nothing to drain). The new build answers
  // with no job and no activation, only the activation record it reconciled
  // on boot: without this the stepper sat on the last download sample.
  if (lastActivation && sameVersion(lastActivation.tag, tag) && (!job || !sameVersion(job.tag, tag))) {
    if (lastActivation.outcome === "activated") return { kind: "applied" };
    if (lastActivation.outcome === "rolled-back" || lastActivation.outcome === "failed") {
      return { kind: "failed", message: lastActivation.message || "Activation failed, rolled back to the previous release." };
    }
  }
  return { kind: "waiting" };
}
