// One update job at a time. Downloads, activations and instant updates
// all go through this coordinator so they can't overlap:
//
//   idle ──download()──▶ downloading ──done──▶ idle
//     │                     │  a second download() for the SAME release joins
//     │                     │  the running job (one fetch, one verify, both
//     │                     │  callers get its result); a different release
//     │                     │  waits for it to finish, then runs.
//     │                     ▼
//     └──beginActivation()─▶ activating (waits for any in-flight download
//                            first, then drain → backup → handoff). While
//                            activating, new downloads are refused with
//                            UpdateBusyError: the process is about to restart.
//
// An "instant" update (download → verify → activate in one go) is an overlay
// record: it holds the slot from the click until the handoff, so a background
// auto-activate can't jump in between its download and its activation.
//
// Why: v0.1.88 → v0.1.89 hit a race where the background watcher and a
// manual "Update to" downloaded the same release in parallel; the watcher
// finished first, auto-activate ("When idle") handed off, and the supervisor
// restarted ShowFlow while the manual request was still open.
//
// No db / network imports, so this is unit-testable on its own; the
// singleton lives in updates_manager.ts.

export type JobSource = "manual" | "auto";

export interface ReleaseMatch {
  tag?: string | null;
  releaseId?: string | null;
}

/** Same release? The tarball sha (releaseId) wins when both sides know it; otherwise the tag. */
export function sameRelease(a: ReleaseMatch, b: ReleaseMatch): boolean {
  if (a.releaseId && b.releaseId) return a.releaseId === b.releaseId;
  const ta = a.tag?.trim().replace(/^v/i, "");
  const tb = b.tag?.trim().replace(/^v/i, "");
  return !!ta && ta === tb;
}

export interface DownloadJob {
  tag: string | null;
  releaseId: string | null;
  source: JobSource;
  startedAt: string;
  /** Callers that joined this job instead of starting their own. */
  joiners: number;
}

export interface ActivationJob {
  tag: string | null;
  releaseId: string;
  source: JobSource;
  startedAt: string;
}

export type InstantStep = "download" | "activate" | "failed" | "done";

export interface InstantJob {
  tag: string | null;
  releaseId: string | null;
  source: JobSource;
  step: InstantStep;
  message: string | null;
  startedAt: string;
}

export type CoordinatorPhase = "idle" | "downloading" | "activating";

export interface CoordinatorSnapshot {
  phase: CoordinatorPhase;
  download: DownloadJob | null;
  activation: ActivationJob | null;
  instant: InstantJob | null;
}

export class UpdateBusyError extends Error {
  constructor(public readonly activation: ActivationJob) {
    super(`ShowFlow is activating ${activation.tag ?? activation.releaseId} and restarts shortly; try again afterwards.`);
    this.name = "UpdateBusyError";
  }
}

export interface DownloadHandle {
  /** Record the release sha once it's resolved (lets a by-sha caller join a by-tag job). */
  setReleaseId(id: string): void;
}

export class UpdateCoordinator<R> {
  private dl: (DownloadJob & { promise: Promise<R> }) | null = null;
  private act: ActivationJob | null = null;
  private inst: InstantJob | null = null;
  private instTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** A finished/failed instant job stays visible to the panel this long. */
    private readonly instantLingerMs = 60_000,
  ) {}

  phase(): CoordinatorPhase {
    if (this.act) return "activating";
    if (this.dl) return "downloading";
    return "idle";
  }

  snapshot(): CoordinatorSnapshot {
    return {
      phase: this.phase(),
      download: this.currentDownload(),
      activation: this.currentActivation(),
      instant: this.inst ? { ...this.inst } : null,
    };
  }

  /** A download is running, or an instant update sits between its download and its activation. */
  downloadBusy(): boolean {
    return !!this.dl || (this.isLiveInstant() && !this.act);
  }

  currentDownload(): DownloadJob | null {
    const d = this.dl;
    return d ? { tag: d.tag, releaseId: d.releaseId, source: d.source, startedAt: d.startedAt, joiners: d.joiners } : null;
  }

  currentActivation(): ActivationJob | null {
    return this.act ? { ...this.act } : null;
  }

  /**
   * Run (or join) a download of `match`. Resolves with the job's result and
   * whether this caller joined someone else's job. Throws UpdateBusyError
   * while an activation holds the slot.
   */
  async download(match: ReleaseMatch, source: JobSource, fn: (h: DownloadHandle) => Promise<R>): Promise<{ result: R; joined: boolean }> {
    for (;;) {
      const cur = this.dl;
      if (cur && sameRelease(cur, match)) {
        cur.joiners++;
        return { result: await cur.promise, joined: true };
      }
      if (this.act) throw new UpdateBusyError({ ...this.act });
      if (!cur) break;
      // A different release is downloading: one job at a time, wait our turn.
      await cur.promise.catch(() => {});
    }
    const job: DownloadJob & { promise: Promise<R> } = {
      tag: match.tag ?? null,
      releaseId: match.releaseId ?? null,
      source,
      startedAt: this.now().toISOString(),
      joiners: 0,
      promise: null as unknown as Promise<R>,
    };
    const handle: DownloadHandle = {
      setReleaseId: (id) => {
        job.releaseId = id;
        if (this.inst && !this.inst.releaseId && sameRelease(this.inst, { tag: job.tag })) this.inst.releaseId = id;
      },
    };
    this.dl = job;
    // The slot is cleared before anyone awaiting the promise resumes, so a
    // caller that activates right after its download sees it free.
    job.promise = Promise.resolve()
      .then(() => fn(handle))
      .finally(() => {
        if (this.dl === job) this.dl = null;
      });
    return { result: await job.promise, joined: false };
  }

  /** Resolves once no download is in flight (including ones that start while waiting). */
  async waitForDownloads(): Promise<void> {
    while (this.dl) await this.dl.promise.catch(() => {});
  }

  /**
   * Claim the slot for an activation. Synchronous so two claims can't race;
   * false when another activation already holds it. The caller then awaits
   * waitForDownloads() before draining, and calls endActivation() when it
   * gives up (postponed / failed) without handing off.
   */
  beginActivation(job: Omit<ActivationJob, "startedAt">): boolean {
    if (this.act) return false;
    this.act = { ...job, startedAt: this.now().toISOString() };
    return true;
  }

  endActivation(releaseId?: string): void {
    if (!this.act) return;
    if (releaseId && this.act.releaseId !== releaseId) return;
    this.act = null;
  }

  // ---- Instant update overlay --------------------------------------------

  private isLiveInstant(): boolean {
    return !!this.inst && (this.inst.step === "download" || this.inst.step === "activate");
  }

  /** The live instant update, if any. */
  currentInstant(): InstantJob | null {
    return this.isLiveInstant() ? { ...this.inst! } : null;
  }

  /**
   * Start tracking an instant update. `joined` when the same release is
   * already being instant-updated; null when a different update holds the
   * slot (another instant update, or activation of another release).
   */
  beginInstant(match: ReleaseMatch, source: JobSource): { job: InstantJob; joined: boolean } | null {
    if (this.isLiveInstant()) {
      return sameRelease(this.inst!, match) ? { job: { ...this.inst! }, joined: true } : null;
    }
    if (this.act && !sameRelease(this.act, match)) return null;
    if (this.instTimer) { clearTimeout(this.instTimer); this.instTimer = null; }
    this.inst = {
      tag: match.tag ?? null,
      releaseId: match.releaseId ?? null,
      source,
      step: "download",
      message: null,
      startedAt: this.now().toISOString(),
    };
    return { job: { ...this.inst }, joined: false };
  }

  updateInstant(patch: Partial<Pick<InstantJob, "step" | "message" | "releaseId" | "tag">>): void {
    if (!this.inst) return;
    this.inst = { ...this.inst, ...patch };
    if (patch.step === "failed" || patch.step === "done") {
      // Keep the outcome briefly so the panel's next poll still sees it.
      if (this.instTimer) clearTimeout(this.instTimer);
      const ended = this.inst;
      this.instTimer = setTimeout(() => {
        if (this.inst === ended) this.inst = null;
        this.instTimer = null;
      }, this.instantLingerMs);
      (this.instTimer as { unref?: () => void }).unref?.();
    }
  }
}
