// Bridges the app's public, authenticated /api/admin/updates/* routes to
// two things that must never be exposed outside the pod:
//   1. GitHub's Releases API (for release discovery + asset download — for
//      public repos no auth is needed; set GITHUB_TOKEN for private repos)
//   2. The supervisor's loopback-only admin API on 127.0.0.1:9090 (install /
//      activate / status — no auth of its own by design)
//
// IMPORTANT — releaseId identity:
// The supervisor keys everything (download dir, releases dir, readiness
// cross-check) off a single `releaseId` string, and its own readiness check
// (waitReadyRepeated in supervisor/activate.ts) requires the *running app's*
// compiled-in BUILD_COMMIT to equal `manifest.commit`. We derive the
// releaseId from the tarball filename (showflow-<sha>.tar.gz). The manifest
// inside the tarball records `releaseId === commit` — the supervisor uses
// that during verification, so the SHA from the filename must match the
// commit inside.
//
// IMPORTANT — tarball format:
// Each GitHub Release publishes a single `showflow-<sha>.tar.gz` containing
// `showflow` (the compiled binary) and `manifest.json` at the root. The
// supervisor's native Bun.Archive support handles extraction even in
// distroless images.

import { mkdir, rename, unlink } from "node:fs/promises";

const GITHUB_API = "https://api.github.com";

// GitHub's *unauthenticated* API budget is 60 req/hr per IP. The Updates
// panel polls the releases list every few seconds, so without a cache a
// single "Track Build" session burns the whole budget in minutes and every
// subsequent poll gets a 429. We cache raw responses with a TTL that's
// generous for unauthenticated calls and tight when a token is configured.
const RELEASE_LIST_TTL_UNAUTHED_MS = 90_000;
const RELEASE_LIST_TTL_AUTHED_MS = 15_000;
const BUILD_DETAIL_TTL_UNAUTHED_MS = 90_000;
const BUILD_DETAIL_TTL_AUTHED_MS = 15_000;
/** When GitHub reports this few requests remaining, stop hammering and let
 *  the cache go stale rather than exhaust the quota mid-build. */
const RATE_LIMIT_SAFETY_FLOOR = 10;
/** How long to hold cache entries after hitting the safety floor. */
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Applies the GitHub quota-cooldown to every cache key sharing a repo+token
 *  bucket, so one exhausted response backs the whole panel off at once. */
function applyRateLimitCooldown(): void {
  const until = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  for (const entry of responseCache.values()) {
    if (entry.expiresAt < until) entry.expiresAt = until;
  }
}

function ttlFor(token: string | undefined, authedTtl: number, unauthTtl: number): number {
  return token ? authedTtl : unauthTtl;
}

function rateLimited(res: Response): boolean {
  const header = res.headers.get("x-ratelimit-remaining");
  if (header === null) return false; // no quota info (e.g. a CDN response) — don't invent a "0 remaining"
  const remaining = Number(header);
  if (Number.isFinite(remaining) && remaining >= 0 && remaining < RATE_LIMIT_SAFETY_FLOOR) {
    console.warn(`[updates] GitHub rate limit nearly exhausted (${remaining} remaining) — cooling down cache for 10 min`);
    applyRateLimitCooldown();
    return true;
  }
  return false;
}

// Matches the supervisor's own defaults exactly (supervisor/state.ts) — the
// app and the supervisor are two processes sharing the same /data PVC
// inside one pod, so both must agree on this path without any IPC beyond
// the filesystem + the loopback admin API.
const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";
const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;
const ADMIN_PORT = Number(process.env.SHOWFLOW_ADMIN_PORT ?? 9090);
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;

export interface BuildDetails {
  status: string; // "in_progress", "queued", "completed", etc.
  conclusion: string | null;
  htmlUrl: string | null;
  name: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  durationSeconds?: number;
}

export interface ReleaseSummary {
  githubReleaseId: number;
  tagName: string;
  name: string | null;
  body: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  isLikelyCurrent: boolean;
  hasRequiredAssets: boolean;
  buildInProgress: boolean;
  buildDetails?: BuildDetails | null;
  assets: { id: number; name: string; sizeBytes: number }[];
}

function githubConfig(): { token?: string; repo: string } {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    throw new Error("Release updates are not configured — set GITHUB_REPO environment variable.");
  }
  return { token: token || undefined, repo };
}

function githubHeaders(token: string | undefined, accept = "application/vnd.github+json"): HeadersInit {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "showflow-updates",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

// ---- Release discovery -----------------------------------------------

const RELEASES_PER_PAGE = 100;

export async function listReleases(currentVersion: string, page = 1): Promise<{ releases: ReleaseSummary[]; hasMore: boolean }> {
  let token: string | undefined;
  let repo: string | undefined;
  try {
    const cfg = githubConfig();
    token = cfg.token;
    repo = cfg.repo;
  } catch {
    // GITHUB_REPO not set — local/dev deployment without GitHub integration
    return { releases: [], hasMore: false };
  }

  // Serve from cache when fresh — the Updates panel polls every few seconds
  // and GitHub's unauthenticated quota (60/hr) cannot survive that.
  const cacheKey = `releases:${repo}:${token ? 'auth' : 'unauth'}:${page}`;
  const ttl = ttlFor(token, RELEASE_LIST_TTL_AUTHED_MS, RELEASE_LIST_TTL_UNAUTHED_MS);
  const cached = cacheGet<{ releases: ReleaseSummary[]; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    if (res.status === 429) rateLimited(res);
    throw new Error(`GitHub releases API returned ${res.status}: ${await res.text()}`);
  }
  rateLimited(res);
  const raw = (await res.json()) as any[];

  const releases = await Promise.all(
    raw
      .filter((r) => !r.draft)
      .map(async (r): Promise<ReleaseSummary> => {
        const assets = (r.assets ?? []) as any[];
        const hasTarball = assets.some((a) => a.name.startsWith("showflow-") && a.name.endsWith(".tar.gz"));
        const build = hasTarball ? null : await fetchBuildDetailsCached(token, repo, r.tag_name);
        const inProgress = build?.status === "in_progress" || build?.status === "queued" || build?.status === "requested";

        return {
          githubReleaseId: r.id,
          tagName: r.tag_name,
          name: r.name ?? null,
          body: typeof r.body === 'string' && r.body.trim() ? r.body : null,
          publishedAt: r.published_at ?? null,
          prerelease: !!r.prerelease,
          isLikelyCurrent: r.tag_name === currentVersion,
          hasRequiredAssets: hasTarball,
          buildInProgress: inProgress,
          buildDetails: build,
          assets: assets.map((a) => ({ id: a.id, name: a.name, sizeBytes: a.size })),
        };
      }),
  );

  const result = { releases, hasMore: raw.length === RELEASES_PER_PAGE };
  cacheSet(cacheKey, result, ttl);
  return result;
}

/**
 * `fetchBuildDetails` behind the same TTL cache, so a "Track Build" poll
 * loop that re-lists releases doesn't re-hit the Actions API every 3s.
 */
async function fetchBuildDetailsCached(token: string | undefined, repo: string, tagName: string): Promise<BuildDetails | null> {
  const cacheKey = `build:${repo}:${token ? 'auth' : 'unauth'}:${tagName}`;
  const ttl = ttlFor(token, BUILD_DETAIL_TTL_AUTHED_MS, BUILD_DETAIL_TTL_UNAUTHED_MS);
  const cached = cacheGet<BuildDetails | null>(cacheKey);
  if (cached !== undefined) return cached;

  const build = await fetchBuildDetails(token, repo, tagName);
  cacheSet(cacheKey, build, ttl);
  return build;
}

/**
 * Checks GitHub Actions workflow runs for a release tag to get detailed build status,
 * timestamps, and run URL.
 */
async function fetchBuildDetails(token: string | undefined, repo: string, tagName: string): Promise<BuildDetails | null> {
  try {
    // Check runs for head tag or branch
    const params = new URLSearchParams({ per_page: "5" });
    const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs?${params}`, { headers: githubHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as { workflow_runs?: any[] };
    const runs = data.workflow_runs ?? [];
    
    // Find run associated with this tag / release event
    const matchedRun = runs.find((run: any) => run.head_branch === tagName || run.display_title?.includes(tagName));
    if (!matchedRun) return null;

    const createdAt = matchedRun.created_at ? new Date(matchedRun.created_at).getTime() : Date.now();
    const updatedAt = matchedRun.updated_at ? new Date(matchedRun.updated_at).getTime() : Date.now();
    const durationSeconds = Math.round((updatedAt - createdAt) / 1000);

    return {
      status: matchedRun.status,
      conclusion: matchedRun.conclusion ?? null,
      htmlUrl: matchedRun.html_url ?? null,
      name: matchedRun.name ?? "Build & Push Docker Image",
      createdAt: matchedRun.created_at ?? null,
      updatedAt: matchedRun.updated_at ?? null,
      durationSeconds: Math.max(0, durationSeconds),
    };
  } catch {
    return null;
  }
}

// ---- Download + local install (writes to /data/downloads/<releaseId>) -

// ---- Download progress (polled by the Updates panel via /pending) -------

export type DownloadPhase = "resolving" | "downloading" | "verifying" | "staged" | "error";

export interface DownloadProgress {
  tag: string | null;
  releaseId: string | null;
  phase: DownloadPhase;
  receivedBytes: number;
  totalBytes: number | null;
  attempt: number;
  message: string | null;
  updatedAt: string;
}

let downloadProgress: DownloadProgress | null = null;

export function getDownloadProgress(): DownloadProgress | null {
  return downloadProgress;
}

function setProgress(p: Partial<DownloadProgress>): void {
  downloadProgress = {
    tag: null, releaseId: null, phase: "resolving", receivedBytes: 0, totalBytes: null, attempt: 1, message: null,
    ...(downloadProgress ?? {}),
    ...p,
    updatedAt: new Date().toISOString(),
  };
}

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_BACKOFF_MS = [2_000, 10_000];

/**
 * Streams a release asset to `destFile` (no whole-tarball ArrayBuffer in
 * memory — the NAS pod is memory-tight), hashing as it goes. Verifies the
 * byte count against the asset's size and, when GitHub supplies one, its
 * `sha256:` digest. Retries transient failures with a short backoff.
 */
async function downloadAssetToFile(
  asset: { id: number; size?: number; digest?: string | null },
  token: string | undefined,
  repo: string,
  destFile: string,
  onProgress?: (received: number, total: number | null, attempt: number) => void,
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      // The asset-by-id endpoint (not browser_download_url) is what works for
      // private repos — it accepts the same Bearer token as the rest of the
      // API. `Accept: application/octet-stream` returns raw bytes.
      const res = await fetch(`${GITHUB_API}/repos/${repo}/releases/assets/${asset.id}`, {
        headers: githubHeaders(token, "application/octet-stream"),
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new Error(`GitHub returned ${res.status} for asset ${asset.id}`);
      }
      const total = Number(res.headers.get("content-length")) || asset.size || null;
      const hasher = new Bun.CryptoHasher("sha256");
      const sink = Bun.file(`${destFile}.part`).writer();
      let received = 0;
      let lastTick = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          sink.write(chunk);
          hasher.update(chunk);
          received += chunk.byteLength;
          if (onProgress && Date.now() - lastTick > 250) {
            lastTick = Date.now();
            onProgress(received, total, attempt);
          }
        }
      } finally {
        await sink.end();
      }
      onProgress?.(received, total, attempt);
      if (asset.size && received !== asset.size) {
        throw new Error(`size mismatch: got ${received} bytes, expected ${asset.size}`);
      }
      const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : null;
      if (digest) {
        const got = hasher.digest("hex");
        if (got !== digest) throw new Error(`sha256 mismatch: got ${got.slice(0, 12)}…, expected ${digest.slice(0, 12)}…`);
      }
      await rename(`${destFile}.part`, destFile);
      return;
    } catch (err) {
      lastErr = err;
      await unlink(`${destFile}.part`).catch(() => {});
      if (attempt < DOWNLOAD_ATTEMPTS) {
        console.warn(`[updates] download attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) — retrying`);
        await Bun.sleep(DOWNLOAD_BACKOFF_MS[attempt - 1] ?? 10_000);
      }
    }
  }
  throw new Error(`Failed to download release asset ${asset.id} after ${DOWNLOAD_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Download → supervisor verify/stage, with progress phases recorded for the UI. */
async function stageRelease(
  tag: string,
  tarballAsset: any,
  token: string | undefined,
  repo: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<{ ok: boolean; message: string; releaseId?: string }> {
  const releaseId = releaseIdFromAsset(tarballAsset.name);
  setProgress({ tag, releaseId, phase: "downloading", receivedBytes: 0, totalBytes: tarballAsset.size ?? null, attempt: 1, message: null });
  try {
    await installTarball(tarballAsset, token, repo, (received, total, attempt) => {
      setProgress({ receivedBytes: received, totalBytes: total, attempt });
      onProgress?.(received, total);
    });
    setProgress({ phase: "verifying", message: "Supervisor is extracting and verifying the build…" });
    const result = await callSupervisor("/admin/install-archive", { releaseId, tarball: `${DOWNLOADS_DIR}/${releaseId}/release.tar.gz` });
    setProgress(result.ok ? { phase: "staged", message: result.message } : { phase: "error", message: result.message });
    return { ...result, releaseId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setProgress({ phase: "error", message });
    return { ok: false, message, releaseId };
  }
}

function releaseIdFromAsset(name: string): string {
  return name.replace(/^showflow-/, "").replace(/\.tar\.gz$/, "");
}

/**
 * Resolves a release by its tag (`releases.atom` only exposes tags, not the
 * numeric release id) and downloads + installs its tarball. Exactly one
 * rate-limited API call per *actual* new release — the watcher's cheap feed
 * polling never touches this endpoint. Kept separate from listReleases so a
 * background auto-download never needs the full releases list.
 */
export async function downloadAndInstallByTag(
  tag: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<{ ok: boolean; message: string; releaseId?: string }> {
  const { token, repo } = githubConfig();
  setProgress({ tag, releaseId: null, phase: "resolving", receivedBytes: 0, totalBytes: null, attempt: 1, message: null });

  const relRes = await fetch(`${GITHUB_API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(token),
  });
  if (!relRes.ok) {
    if (relRes.status === 429) rateLimited(relRes);
    throw new Error(`GitHub release "${tag}" not found (${relRes.status}).`);
  }
  rateLimited(relRes);
  const release = (await relRes.json()) as any;
  const assets = (release.assets ?? []) as any[];
  const tarballAsset = assets.find((a) => a.name.startsWith("showflow-") && a.name.endsWith(".tar.gz"));
  if (!tarballAsset) {
    const message = `Release "${tag}" has no showflow-<sha>.tar.gz asset yet (CI may still be building).`;
    setProgress({ phase: "error", message });
    return { ok: false, message };
  }

  return stageRelease(tag, tarballAsset, token, repo, onProgress);
}

/**
 * Downloads a GitHub release's `showflow-<sha>.tar.gz` into
 * /data/downloads/<releaseId>/ and hands off to the supervisor's
 * /admin/install-archive, which extracts and verifies the content
 * independently before copying into its own releases directory.
 */
export async function downloadAndInstall(githubReleaseId: number): Promise<{ ok: boolean; message: string; releaseId?: string }> {
  const { token, repo } = githubConfig();

  const relRes = await fetch(`${GITHUB_API}/repos/${repo}/releases/${githubReleaseId}`, {
    headers: githubHeaders(token),
  });
  if (!relRes.ok) {
    throw new Error(`GitHub release ${githubReleaseId} not found (${relRes.status}).`);
  }
  const release = (await relRes.json()) as any;
  const assets = (release.assets ?? []) as any[];
  const tarballAsset = assets.find((a) => a.name.startsWith("showflow-") && a.name.endsWith(".tar.gz"));
  if (!tarballAsset) {
    return { ok: false, message: `Release "${release.tag_name}" is missing required tarball asset (showflow-<sha>.tar.gz).` };
  }

  return stageRelease(release.tag_name, tarballAsset, token, repo);
}

/** Shared tarball download + stage-to-disk used by both id- and tag-based install. */
async function installTarball(
  tarballAsset: { id: number; name: string; size?: number; digest?: string | null },
  token: string | undefined,
  repo: string,
  onProgress?: (received: number, total: number | null, attempt: number) => void,
): Promise<string> {
  const releaseId = releaseIdFromAsset(tarballAsset.name);
  const dest = `${DOWNLOADS_DIR}/${releaseId}`;
  await mkdir(dest, { recursive: true });
  await downloadAssetToFile(tarballAsset, token, repo, `${dest}/release.tar.gz`, onProgress);
  return releaseId;
}

// ---- Supervisor admin bridge -------------------------------------------

async function callSupervisor(pathname: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${ADMIN_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  return { ok: res.ok && parsed.ok === true, message: parsed.message ?? `Supervisor returned ${res.status}` };
}

/**
 * Triggers activation on the supervisor without assuming we'll ever see its
 * final response.
 *
 * Why: this app process IS the "current" release the supervisor is about to
 * replace. Its own activate() sequence (supervisor/activate.ts) verifies
 * the manifest/checksum FIRST, and only *after* that sends SIGTERM to the
 * currently-running app (us) before spawning the candidate. So:
 *   - Pre-flight failures (bad releaseId, no manifest, checksum mismatch,
 *     "activation already in progress") happen before we're killed — the
 *     supervisor's response reaches us normally, and we forward it as-is.
 *   - Success (and failures discovered only after our replacement starts,
 *     e.g. a readiness timeout or restore-to-lastKnownGood) can NEVER reach
 *     us — we're SIGTERM'd before the supervisor gets that far. Awaiting
 *     the full response in that case would hang forever, since the process
 *     that would resolve the await is dead.
 * A short timeout distinguishes the two: if the supervisor hasn't replied
 * within it, activation passed validation and is now in progress. From
 * there the true outcome is only observable via /internal/ready's
 * `releaseId` — which is exactly the frontend's documented reconnect
 * contract (poll with backoff, reload once releaseId matches the target).
 */
export async function triggerActivate(releaseId: string): Promise<{ ok: boolean; message: string; timedOut?: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ releaseId }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok === true, message: body.message ?? `Supervisor returned ${res.status}` };
  } catch (err) {
    // Both a timeout and a connection-reset (supervisor killed us during
    // quiescing) mean activation passed pre-flight checks — the supervisor
    // is now in control and the outcome is observable via /internal/ready.
    if ((err as any)?.name === "AbortError" || (err as any)?.type === "system") {
      return {
        ok: true,
        timedOut: true,
        message: `Activation of "${releaseId}" passed validation and is now in progress. This app process will restart shortly — poll /internal/ready and watch for its releaseId to change.`,
      };
    }
    return { ok: false, message: `Could not reach the supervisor admin API: ${String(err)}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getSupervisorStatus(): Promise<any> {
  const res = await fetch(`${ADMIN_BASE}/admin/status`);
  if (!res.ok) {
    throw new Error(`Supervisor admin status returned ${res.status}`);
  }
  return res.json();
}
