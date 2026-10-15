// Shared types, paths, and the atomic state-file write used by both the
// daemon and the CLI side of the supervisor binary.

import { rename, stat } from "node:fs/promises";

export const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";
export const RELEASES_DIR = `${DATA_DIR}/releases`;
export const STATE_DIR = `${DATA_DIR}/state`;
export const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;
export const STATE_FILE = `${STATE_DIR}/active.json`;
export const BOOTSTRAP_APP = process.env.SHOWFLOW_BOOTSTRAP_APP ?? "/bootstrap/showflow";
export const BOOTSTRAP_MANIFEST = process.env.SHOWFLOW_BOOTSTRAP_MANIFEST ?? "/bootstrap/manifest.json";
export const BOOTSTRAP_MIGRATIONS = process.env.SHOWFLOW_BOOTSTRAP_MIGRATIONS ?? "/bootstrap/migrations";

export const PUBLIC_PORT = Number(process.env.PORT ?? 3000);
// Loopback-only admin surface. kubectl exec runs inside the same network
// namespace as the daemon, so 127.0.0.1 is reachable from an `exec`'d CLI
// invocation of this same binary without ever exposing install/activate
// outside the pod.
export const ADMIN_PORT = Number(process.env.SHOWFLOW_ADMIN_PORT ?? 9090);

export type Phase = "stable" | "quiescing" | "stopped" | "starting" | "restoring";

/**
 * Supervisor version, resolved at runtime:
 * 1. SUPERVISOR_VERSION env var (set by Dockerfile from the CI's git tag)
 * 2. Fallback to the compiled-in default
 *
 * The Dockerfile sets ENV SUPERVISOR_VERSION from the Git tag at image-build
 * time, so the supervisor knows its own version and can reject release
 * manifests that require a newer version than what's running.
 */
export const SUPERVISOR_VERSION: string = process.env.SUPERVISOR_VERSION || "0.0.0";

export interface Manifest {
  releaseId: string;
  version: string;
  commit: string;
  platform: string;
  readyPath: string;
  artifact: { name: string; sha256: string };
  minimumSupervisorVersion: string;
}

export interface State {
  active: string | null;
  lastKnownGood: string | null;
  candidate?: string;
  phase: Phase;
  updatedAt: string;
}

export const DEFAULT_STATE: State = {
  active: null,
  lastKnownGood: null,
  phase: "starting",
  updatedAt: new Date(0).toISOString(),
};

export async function readState(): Promise<State> {
  const file = Bun.file(STATE_FILE);
  if (!(await file.exists())) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...(await file.json()) };
  } catch {
    // Corrupt state file (e.g. a crash mid-write before the rename landed,
    // or before this atomic-write path existed) — treat as fresh rather
    // than crash-looping the supervisor on startup.
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write state via write-then-rename rather than an in-place write, so a
 * crash mid-write can never leave active.json half-written. Bun.write to a
 * `.tmp` path followed by renaming over the real path is effectively an
 * atomic replace on the same filesystem (the PVC).
 *
 * Serialized via a simple promise-chain mutex: concurrent callers (e.g. a
 * SIGTERM handler racing with an in-progress activation) queue rather than
 * silently overwriting each other's writes.
 */
let stateWriteLock: Promise<State> = Promise.resolve<State>(undefined as unknown as State);

export async function writeStateAtomic(state: Partial<State>): Promise<State> {
  await stateWriteLock;
  return stateWriteLock = (async () => {
    const current = await readState();
    const next: State = { ...current, ...state, updatedAt: new Date().toISOString() };
    // Write to a temp file, then rename over the real path. On the same
    // filesystem (the PVC), POSIX rename() is atomic — a reader never sees a
    // partially-written state file, and a crash between the write and the
    // rename just leaves the .tmp file orphaned rather than corrupting
    // active.json.
    const tmp = `${STATE_FILE}.tmp`;
    await Bun.write(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, STATE_FILE);
    return next;
  })();
}

export function releasePath(releaseId: string): string {
  return `${RELEASES_DIR}/${releaseId}`;
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  const file = Bun.file(`${dir}/manifest.json`);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Verifies the release directory's `app` binary matches the sha256 recorded
 * in its own manifest.json. This is what stops a mislabeled or corrupted
 * artifact from ever being trusted, independent of the binary's own
 * compiled-in __BUILD_COMMIT__ (checked separately, at readiness time,
 * against the manifest's `commit` field).
 */
/** semver comparison. Returns <0, 0, or >0. Handles "0.1.0", "v0.1.0" and
 *  prerelease suffixes (`0.1.80-test.1` < `0.1.80`). Non-semver strings
 *  (e.g. "development") compare equal, as before. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(v.trim());
  const ma = parse(a);
  const mb = parse(b);
  if (!ma || !mb) return 0;
  const pa = ma[1]!.split(".").map(Number);
  const pb = mb[1]!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  const ra = ma[2] ? ma[2].split(".") : [];
  const rb = mb[2] ? mb[2].split(".") : [];
  if (!ra.length || !rb.length) return rb.length - ra.length; // release > prerelease
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Streams a file through sha256 (constant memory — the old version pulled the
 * whole ~96MB binary into an ArrayBuffer, twice per update).
 */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Files this supervisor process already hashed, keyed by path, with the stat
 * fingerprint they had at the time. /data/releases is written only by the
 * supervisor, so if size+mtime+inode are unchanged since we hashed it, hashing
 * again on activate is pure overhead (~1-2s per update on a NAS). Process
 * memory only: a restart re-verifies everything.
 */
const verifiedFiles = new Map<string, { sha256: string; size: number; mtimeMs: number; ino: number }>();

async function fingerprint(path: string): Promise<{ size: number; mtimeMs: number; ino: number } | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch {
    return null;
  }
}

/** Remember that `path` (as it is on disk right now) hashes to `sha256`. */
export async function rememberVerified(path: string, sha256: string): Promise<void> {
  const fp = await fingerprint(path);
  if (fp) verifiedFiles.set(path, { sha256, ...fp });
}

/** Test hook. */
export function forgetVerified(): void {
  verifiedFiles.clear();
}

export async function verifyArtifact(dir: string, manifest: Manifest): Promise<boolean> {
  const path = `${dir}/${manifest.artifact.name}`;
  const fp = await fingerprint(path);
  if (!fp) return false;
  const known = verifiedFiles.get(path);
  if (known && known.sha256 === manifest.artifact.sha256 && known.size === fp.size && known.mtimeMs === fp.mtimeMs && known.ino === fp.ino) {
    return true;
  }
  const sha = await sha256File(path);
  if (sha !== manifest.artifact.sha256) return false;
  verifiedFiles.set(path, { sha256: sha, ...fp });
  return true;
}
