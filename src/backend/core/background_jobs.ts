/**
 * Global Background Activity registry
 * (design-brief-platform-ux-systems.md §2).
 *
 * A single in-memory registry any long-running operation (Sonarr import,
 * library scan, health poll, backup, future features) registers itself
 * against, so the header-level popover and any feature-specific progress
 * view (e.g. the onboarding wizard's import screen) read from the SAME
 * underlying job rather than each maintaining separate state.
 *
 * In-memory is intentional (per the brief: "doesn't need to survive a
 * restart") - this is a single-process app, and a job that was running at
 * the moment of a restart wasn't going to resume cleanly anyway.
 * (TorBox downloads are the exception: their in-flight torrent IDs persist
 * in settings and the waiter re-attaches on boot.)
 *
 * Finished jobs are retained for 24h (capped) so a completed/failed grab
 * can always be traced to its outcome instead of vanishing.
 *
 * This is a registry, not a feature built once per task type - the whole
 * point is that future long-running features get a progress UI for free
 * by registering here instead of reinventing their own.
 */

export type BackgroundJobStatus = 'running' | 'done' | 'error';

export interface BackgroundJobProgress {
  /** Total units of work, if known up front. Undefined for indeterminate jobs. */
  total?: number;
  /** Units completed so far. */
  completed: number;
  /** Free-text detail for the popover, e.g. "42/210 series imported". */
  detail?: string;
}

export interface BackgroundJob {
  id: string;
  /** Job type/category, e.g. 'sonarr-import', 'library-scan', 'health-poll', 'backup'. */
  type: string;
  /** Human-readable label for the popover, e.g. "Importing 210 series from Sonarr". */
  label: string;
  status: BackgroundJobStatus;
  progress: BackgroundJobProgress;
  /** Optional link for "more detail" - e.g. the wizard's import progress view. */
  link?: string;
  startedAt: string;
  finishedAt?: string;
  /** Present when status is 'error'. */
  error?: string;
}

type Listener = (jobs: BackgroundJob[]) => void;

export class BackgroundJobRegistry {  private jobs = new Map<string, BackgroundJob>();
  private listeners = new Set<Listener>();
  /** How long a finished (done/error) job stays visible before eviction. */
  private static RETENTION_MS = 24 * 60 * 60 * 1000;
  /** Cap on retained finished jobs — oldest go first, running jobs exempt. */
  private static MAX_FINISHED = 200;

  register(input: { id: string; type: string; label: string; total?: number; link?: string }): BackgroundJob {
    const job: BackgroundJob = {
      id: input.id,
      type: input.type,
      label: input.label,
      status: 'running',
      progress: { total: input.total, completed: 0 },
      link: input.link,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pruneFinished();
    this.notify();
    return job;
  }

  update(id: string, progress: Partial<BackgroundJobProgress>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = { ...job.progress, ...progress };
    this.notify();
  }

  complete(id: string, detail?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    if (detail) job.progress.detail = detail;
    this.pruneFinished();
    this.notify();
    this.scheduleEviction(id);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.error = error;
    job.finishedAt = new Date().toISOString();
    this.pruneFinished();
    this.notify();
    this.scheduleEviction(id);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(): BackgroundJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listActive(): BackgroundJob[] {
    return this.list().filter((j) => j.status === 'running');
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const jobs = this.list();
    for (const fn of this.listeners) fn(jobs);
  }

  private scheduleEviction(id: string): void {
    setTimeout(() => this.jobs.delete(id), BackgroundJobRegistry.RETENTION_MS);
  }

  private pruneFinished(): void {
    const finished = this.list().filter((j) => j.status !== 'running');
    const over = finished.length - BackgroundJobRegistry.MAX_FINISHED;
    if (over <= 0) return;
    finished
      .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt))
      .slice(0, over)
      .forEach((j) => this.jobs.delete(j.id));
  }
}

/** Single process-wide registry instance - import this, don't construct your own. */
export const backgroundJobs = new BackgroundJobRegistry();
