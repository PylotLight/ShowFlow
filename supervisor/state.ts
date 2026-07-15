// Shared types, paths, and the atomic state-file write used by both the
// daemon and the CLI side of the supervisor binary.

import { rename } from "node:fs/promises";

export const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";
export const RELEASES_DIR = `${DATA_DIR}/releases`;
export const STATE_DIR = `${DATA_DIR}/state`;
export const DOWNLOADS_DIR = `${DATA_DIR}/downloads`;
export const STATE_FILE = `${STATE_DIR}/active.json`;
export const BOOTSTRAP_APP = process.env.SHOWFLOW_BOOTSTRAP_APP ?? "/bootstrap/showflow";
export const BOOTSTRAP_MANIFEST = process.env.SHOWFLOW_BOOTSTRAP_MANIFEST ?? "/bootstrap/manifest.json";

export const PUBLIC_PORT = Number(process.env.PORT ?? 3000);
// Loopback-only admin surface. kubectl exec runs inside the same network
// namespace as the daemon, so 127.0.0.1 is reachable from an `exec`'d CLI
// invocation of this same binary without ever exposing install/activate
// outside the pod.
export const ADMIN_PORT = Number(process.env.SHOWFLOW_ADMIN_PORT ?? 9090);

export type Phase = "stable" | "quiescing" | "stopped" | "starting" | "restoring";

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
 */
export async function writeStateAtomic(state: Partial<State>): Promise<State> {
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
export async function verifyArtifact(dir: string, manifest: Manifest): Promise<boolean> {
  const appFile = Bun.file(`${dir}/${manifest.artifact.name}`);
  if (!(await appFile.exists())) return false;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await appFile.arrayBuffer());
  return hasher.digest("hex") === manifest.artifact.sha256;
}
