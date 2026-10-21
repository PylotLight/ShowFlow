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

export type InstantStepState =
  /** Step 2: downloading / verifying (progress comes from `download`). */
  | { kind: "download" }
  /** Step 3: downloaded + verified, activation running; follow it by releaseId. */
  | { kind: "activate"; releaseId: string }
  | { kind: "failed"; message: string }
  /** Nothing to do (e.g. already running that release). */
  | { kind: "done"; message: string }
  /** No conclusive server state yet. */
  | { kind: "waiting" };

export function instantStepView(tag: string, job: InstantJobView | null, activation: ActivationView | null): InstantStepState {
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
  return { kind: "waiting" };
}
