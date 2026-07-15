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
// compiled-in BUILD_COMMIT to equal `manifest.commit`. build.ts
// sets `manifest.releaseId === manifest.commit`, so the only string that can
// ever satisfy that invariant is the one baked into the manifest itself.
// We never derive releaseId from a GitHub tag_name (e.g. "v0.3.0") — we
// always download manifest.json first and read `releaseId` out of it.
//
// IMPORTANT — no archive format:
// The app process this module runs inside is spawned by the supervisor
// inside the *same* distroless runtime image (gcr.io/distroless/base-debian12)
// as the supervisor itself — no shell, no tar/gzip binary available at
// runtime. Rather than hand-roll a pure-JS tar extractor, each GitHub
// Release is expected to publish exactly two flat assets: `showflow` (the
// compiled binary) and `manifest.json`. No archive to extract.

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

interface Manifest {
  releaseId: string;
  version: string;
  commit: string;
  platform: string;
  readyPath: string;
  artifact: { name: string; sha256: string };
  minimumSupervisorVersion: string;
}

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

export async function listReleases(currentVersion: string): Promise<ReleaseSummary[]> {
  const { token, repo } = githubConfig();
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=20`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases API returned ${res.status}: ${await res.text()}`);
  }
  const releases = (await res.json()) as any[];

  return releases
    .filter((r) => !r.draft)
    .map((r): ReleaseSummary => {
      const assets = (r.assets ?? []) as any[];
      const hasApp = assets.some((a) => a.name === "showflow");
      const hasManifest = assets.some((a) => a.name === "manifest.json");
      return {
        githubReleaseId: r.id,
        tagName: r.tag_name,
        name: r.name ?? null,
        publishedAt: r.published_at ?? null,
        prerelease: !!r.prerelease,
        isLikelyCurrent: r.tag_name === currentVersion,
        hasRequiredAssets: hasApp && hasManifest,
        assets: assets.map((a) => ({ id: a.id, name: a.name, sizeBytes: a.size })),
      };
    });
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
 * Downloads a GitHub release's `showflow` + `manifest.json` assets into
 * /data/downloads/<releaseId>/ and hands off to the supervisor's
 * /admin/install, which re-verifies the checksum independently before
 * copying into its own releases directory. We verify locally too, so a
 * corrupted download fails with a clear message here rather than a vaguer
 * one from the supervisor.
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
  const manifestAsset = assets.find((a) => a.name === "manifest.json");
  const appAsset = assets.find((a) => a.name === "showflow");
  if (!manifestAsset || !appAsset) {
    return { ok: false, message: `Release "${release.tag_name}" is missing required asset(s) — need both "showflow" and "manifest.json".` };
  }

  const manifestBytes = await downloadAsset(manifestAsset.id, token, repo);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    return { ok: false, message: `Release "${release.tag_name}"'s manifest.json is not valid JSON: ${String(err)}` };
  }
  if (!manifest.releaseId || !manifest.artifact?.name || !manifest.artifact?.sha256) {
    return { ok: false, message: `Release "${release.tag_name}"'s manifest.json is missing required fields.` };
  }

  const releaseId = manifest.releaseId;
  const dest = `${DOWNLOADS_DIR}/${releaseId}`;
  await mkdir(dest, { recursive: true });

  const appBytes = await downloadAsset(appAsset.id, token, repo);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(appBytes);
  const actualSha256 = hasher.digest("hex");
  if (actualSha256 !== manifest.artifact.sha256) {
    return { ok: false, message: `Checksum mismatch after download for release "${releaseId}" — refusing to install. Expected ${manifest.artifact.sha256}, got ${actualSha256}.` };
  }

  await Bun.write(`${dest}/${manifest.artifact.name}`, appBytes);
  await Bun.write(`${dest}/manifest.json`, manifestBytes);

  return callSupervisor("/admin/install", { releaseId }).then((result) => ({ ...result, releaseId }));
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
  const timeout = setTimeout(() => controller.abort(), 5000);
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
    if ((err as any)?.name === "AbortError") {
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
