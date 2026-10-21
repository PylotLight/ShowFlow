// Fetch helpers for the Updates panel. Pure (no React) so they're unit-tested.
//
// An in-app update restarts ShowFlow: the supervisor SIGTERMs the running
// app, and until the new build passes its readiness gate every request gets a
// 503 from the supervisor (older supervisors send it as plain text
// "Service Unavailable"), a dropped connection, or an ingress 502/504 page.
// None of that is an API failure, so nothing here ever calls res.json()
// blindly: a restart is reported as `{ kind: "restarting" }` and the panel
// keeps polling instead of marking a step Failed.

export type UpdateFetchResult<T> =
  | { kind: "ok"; status: number; data: T }
  /** ShowFlow is mid-restart (or unreachable): keep polling with backoff. */
  | { kind: "restarting"; status: number | null; reason: string }
  /** A real answer from the app that says something went wrong. */
  | { kind: "error"; status: number; message: string; data: T | null };

/** Gateway-ish statuses a restarting app/supervisor/ingress hands back. */
export function isRestartStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function parseMaybeJson(text: string, contentType: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!contentType.toLowerCase().includes("json") && !/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function messageOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { message?: unknown; error?: unknown };
  if (typeof d.message === "string" && d.message) return d.message;
  if (typeof d.error === "string" && d.error) return d.error;
  return null;
}

/**
 * Classify a Response without assuming its body is JSON.
 *
 * - `restarting`: body says `restarting: true` (new supervisor), or a
 *   502/503/504 whose body isn't JSON (old supervisor's text 503, ingress
 *   HTML, empty body).
 * - `error`: a JSON error from the app itself (including the app's own
 *   502s, e.g. the install route when GitHub fails, which are real
 *   failures), or a non-JSON body on any other status.
 * - `ok`: 2xx with a JSON body.
 */
export async function classifyResponse<T>(res: Response): Promise<UpdateFetchResult<T>> {
  const contentType = res.headers.get("content-type") ?? "";
  let text = "";
  try {
    text = await res.text();
  } catch {
    // Body stream cut off mid-read: the process went away under us.
    return { kind: "restarting", status: res.status, reason: `connection dropped (HTTP ${res.status})` };
  }
  const data = parseMaybeJson(text, contentType);

  if (data && typeof data === "object" && (data as { restarting?: unknown }).restarting === true) {
    return { kind: "restarting", status: res.status, reason: messageOf(data) ?? `HTTP ${res.status}` };
  }
  if (data === undefined) {
    if (isRestartStatus(res.status)) {
      const snippet = text.trim().slice(0, 80);
      return { kind: "restarting", status: res.status, reason: snippet && !snippet.startsWith("<") ? snippet : `HTTP ${res.status}` };
    }
    const kind = contentType.toLowerCase().includes("html") ? "an HTML page" : text.trim() ? "a non-JSON response" : "an empty response";
    return { kind: "error", status: res.status, message: `Unexpected server response (HTTP ${res.status}: ${kind})`, data: null };
  }
  if (!res.ok) {
    return { kind: "error", status: res.status, message: messageOf(data) ?? `HTTP ${res.status}`, data: data as T };
  }
  return { kind: "ok", status: res.status, data: data as T };
}

/**
 * fetch() + classifyResponse(). A network failure (connection refused/reset
 * while the supervisor swaps builds) is `restarting`, not a thrown error.
 * Aborts are rethrown so callers can cancel.
 */
export async function updateFetch<T>(
  url: string,
  init?: RequestInit,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): Promise<UpdateFetchResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") throw err;
    return { kind: "restarting", status: null, reason: err instanceof Error ? err.message : String(err) };
  }
  return classifyResponse<T>(res);
}

/** "v0.1.89" / "0.1.89" / " V0.1.89 " -> "0.1.89"; null for empty. */
export function normalizeVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^v/i, "");
  return s || null;
}

/** True when two version strings name the same release (ignores a leading "v"). */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeVersion(a);
  const y = normalizeVersion(b);
  return x !== null && x === y;
}

export interface RecoveryTarget {
  /** Supervisor release dir (tarball sha), when known. */
  releaseId: string | null;
  /** Release tag, e.g. "v0.1.89", when known. */
  tag: string | null;
}

export interface RecoveryInputs {
  /** /internal/ready body from the process now answering. */
  ready?: { releaseId?: string | null; version?: string | null } | null;
  /** /api/admin/updates/status body. */
  status?: { activeReleaseId?: string | null; phase?: string | null; appVersion?: string | null } | null;
  /** /api/admin/updates/pending body. */
  pending?: {
    pending?: { releaseId: string; tag: string } | null;
    download?: { tag: string | null; phase: string } | null;
    activation?: { releaseId: string; tag: string | null; phase: string; detail?: string } | null;
    lastActivation?: { releaseId: string; tag: string | null; outcome?: string; message?: string } | null;
  } | null;
}

export type RecoveryState =
  /** The target build is the one running: show step 4 success + reload. */
  | { kind: "applied" }
  /** The supervisor rolled back / the activation failed. */
  | { kind: "failed"; message: string }
  /** An activation of the target is still in flight (draining/backing up/handing off). */
  | { kind: "activating"; releaseId: string; phase: string; detail: string }
  /** Still downloading/verifying the target. */
  | { kind: "downloading"; phase: string }
  /** Target is downloaded + verified and waiting for activation. */
  | { kind: "staged"; releaseId: string }
  /** Server is up but nothing conclusive yet: keep polling. */
  | { kind: "waiting" };

function matchesTarget(t: RecoveryTarget, releaseId: string | null | undefined, tag: string | null | undefined): boolean {
  if (t.releaseId && releaseId && t.releaseId === releaseId) return true;
  if (t.tag && tag && sameVersion(t.tag, tag)) return true;
  return false;
}

/**
 * After a restart/reconnect, decide what actually happened to the update
 * from whatever the server reported. Running version === target wins over
 * everything else, so a successful update is never shown as a failure.
 */
export function resolveRecovery(target: RecoveryTarget, inputs: RecoveryInputs): RecoveryState {
  const { ready, status, pending } = inputs;

  if (target.releaseId && ready?.releaseId && ready.releaseId === target.releaseId) return { kind: "applied" };
  if (target.tag && sameVersion(ready?.version, target.tag)) return { kind: "applied" };
  if (status && status.phase === "stable") {
    if (target.releaseId && status.activeReleaseId === target.releaseId) return { kind: "applied" };
    if (target.tag && sameVersion(status.appVersion, target.tag)) return { kind: "applied" };
  }

  const last = pending?.lastActivation;
  if (last && matchesTarget(target, last.releaseId, last.tag) && (last.outcome === "rolled-back" || last.outcome === "failed")) {
    return { kind: "failed", message: last.message ?? "Activation failed, rolled back to the previous release." };
  }

  const act = pending?.activation;
  if (act && matchesTarget(target, act.releaseId, act.tag)) {
    if (act.phase === "failed") return { kind: "failed", message: act.detail || "Activation failed." };
    return { kind: "activating", releaseId: act.releaseId, phase: act.phase, detail: act.detail ?? "" };
  }

  const dl = pending?.download;
  if (dl && target.tag && sameVersion(dl.tag, target.tag) && ["resolving", "downloading", "verifying"].includes(dl.phase)) {
    return { kind: "downloading", phase: dl.phase };
  }

  const staged = pending?.pending;
  if (staged && matchesTarget(target, staged.releaseId, staged.tag)) return { kind: "staged", releaseId: staged.releaseId };

  return { kind: "waiting" };
}
