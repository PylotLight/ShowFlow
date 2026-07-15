// Bridges the app's public, authenticated /api/admin/updates/* routes to
// two things that must never be exposed outside the pod:
//   1. GitHub's Releases API (for release discovery + private-repo asset
//      download — needs GITHUB_TOKEN, which must stay server-side)
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

import { mkdir } from "node:fs/promises";

const GITHUB_API = "https://api.github.com";

// Matches the supervisor's own defaults exactly (supervisor/state.ts) — the
// app and the supervisor are two processes sharing the same /data PVC
// inside one pod, so both must agree on this path without any IPC beyond
// the filesystem + the loopback admin API.
const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";
const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;
const ADMIN_PORT = Number(process.env.SHOWFLOW_ADMIN_PORT ?? 9090);
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;

export interface ReleaseSummary {
  githubReleaseId: number;
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  /**
   * Best-effort only — compares the GitHub tag against the running app's
   * own BUILD_VERSION. The authoritative check is whether /internal/ready's
   * `releaseId` (the compiled-in commit) matches after activation, since a
   * tag can be re-pushed to point at a different commit.
   */
  isLikelyCurrent: boolean;
  hasRequiredAssets: boolean;
  assets: { id: number; name: string; sizeBytes: number }[];
}

function githubConfig(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    throw new Error("Release updates are not configured — set GITHUB_TOKEN and GITHUB_REPO environment variables.");
  }
  return { token, repo };
}

function githubHeaders(token: string, accept = "application/vnd.github+json"): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "User-Agent": "showflow-updates",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---- Release discovery -----------------------------------------------

const RELEASES_PER_PAGE = 100;

export async function listReleases(currentVersion: string, page = 1): Promise<{ releases: ReleaseSummary[]; hasMore: boolean }> {
  const { token, repo } = githubConfig();
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API returned ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as any[];

  const releases = raw
    .filter((r) => !r.draft)
    .map((r): ReleaseSummary => {
      const assets = (r.assets ?? []) as any[];
      const hasTarball = assets.some((a) => a.name.startsWith("showflow-") && a.name.endsWith(".tar.gz"));
      return {
        githubReleaseId: r.id,
        tagName: r.tag_name,
        name: r.name ?? null,
        publishedAt: r.published_at ?? null,
        prerelease: !!r.prerelease,
        isLikelyCurrent: r.tag_name === currentVersion,
        hasRequiredAssets: hasTarball,
        assets: assets.map((a) => ({ id: a.id, name: a.name, sizeBytes: a.size })),
      };
    });

  return { releases, hasMore: raw.length === RELEASES_PER_PAGE };
}

// ---- Download + local install (writes to /data/downloads/<releaseId>) -

async function downloadAsset(assetId: number, token: string, repo: string): Promise<ArrayBuffer> {
  // The asset-by-id endpoint (not the asset's browser_download_url) is what
  // works for private repos — it accepts the same Bearer token as the rest
  // of the API. `Accept: application/octet-stream` tells GitHub to return
  // raw bytes instead of the asset's JSON metadata for this same URL.
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases/assets/${assetId}`, {
    headers: githubHeaders(token, "application/octet-stream"),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Failed to download release asset ${assetId}: GitHub returned ${res.status}`);
  }
  return res.arrayBuffer();
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

  const tarballBytes = await downloadAsset(tarballAsset.id, token, repo);

  const releaseId = tarballAsset.name.replace(/^showflow-/, "").replace(/\.tar\.gz$/, "");
  const dest = `${DOWNLOADS_DIR}/${releaseId}`;
  await mkdir(dest, { recursive: true });

  const tarballPath = `${dest}/release.tar.gz`;
  await Bun.write(tarballPath, tarballBytes);

  return callSupervisor("/admin/install-archive", { releaseId, tarball: tarballPath }).then((result) => ({ ...result, releaseId }));
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
