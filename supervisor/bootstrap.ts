// Cold-start path for a fresh PVC (new pod, lost volume, disaster
// recovery). Without this, `Restoring` in the state machine has nothing to
// terminate at — v1 skipped this entirely.

import { mkdir, chmod } from "node:fs/promises";
import {
  RELEASES_DIR,
  STATE_DIR,
  DOWNLOADS_DIR,
  BOOTSTRAP_APP,
  BOOTSTRAP_MANIFEST,
  verifyArtifact,
  releasePath,
  readState,
  SUPERVISOR_VERSION,
  compareVersions,
} from "./state";

export async function ensureDataDirs(): Promise<void> {
  await mkdir(RELEASES_DIR, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
  await mkdir(DOWNLOADS_DIR, { recursive: true });
}

/**
 * If /data/releases is empty (fresh PVC), install the release baked into
 * the image at /bootstrap as lastKnownGood before anything else runs. If a
 * release already exists on the PVC, this is a no-op — the image's
 * bundled release is never used to override state that's already there.
 *
 * Returns the release ID to activate on this boot, or null if there's
 * nothing installed and no bootstrap release available either (should be
 * unreachable in a correctly-built image, but fails loudly rather than
 * silently if it happens).
 */
export async function ensureBootstrapInstalled(): Promise<string | null> {
  const state = await readState();
  if (state.lastKnownGood) {
    return state.lastKnownGood;
  }

  const bootstrapManifestFile = Bun.file(BOOTSTRAP_MANIFEST);
  const bootstrapAppFile = Bun.file(BOOTSTRAP_APP);
  if (!(await bootstrapManifestFile.exists()) || !(await bootstrapAppFile.exists())) {
    console.error("[supervisor] no lastKnownGood on the PVC and no /bootstrap release baked into the image — cannot start.");
    return null;
  }

  const manifest = await bootstrapManifestFile.json();
  if (manifest.minimumSupervisorVersion && compareVersions(SUPERVISOR_VERSION, manifest.minimumSupervisorVersion) < 0) {
    console.error(
      `[supervisor] bootstrap release requires supervisor ${manifest.minimumSupervisorVersion}, ` +
      `but this supervisor is version ${SUPERVISOR_VERSION}. The image is too old to run its own bundled release — rebuild the image with a newer supervisor.`,
    );
    return null;
  }
  const dir = releasePath(manifest.releaseId);
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/${manifest.artifact.name}`, bootstrapAppFile);
  await Bun.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

  // chmod +x — Bun.write doesn't preserve the executable bit from a compiled
  // binary source file automatically. Uses node:fs directly rather than
  // spawning a `chmod` process: the distroless runtime image has no shell
  // or coreutils, only whatever is embedded in this compiled binary.
  await chmod(`${dir}/${manifest.artifact.name}`, 0o755);

  const verified = await verifyArtifact(dir, manifest);
  if (!verified) {
    console.error(`[supervisor] bootstrap release "${manifest.releaseId}" failed checksum verification after install.`);
    return null;
  }

  console.log(`[supervisor] installed bootstrap release "${manifest.releaseId}" as lastKnownGood.`);
  return manifest.releaseId;
}


