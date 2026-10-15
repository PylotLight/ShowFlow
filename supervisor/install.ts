// Install a downloaded release into /data/releases/<releaseId>. Split out of
// index.ts (which boots the daemon on import) so it's testable.

import { mkdir, chmod, cp, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DOWNLOADS_DIR, BOOTSTRAP_MIGRATIONS, readManifest, releasePath, sha256File, rememberVerified } from "./state";

export async function installRelease(releaseId: string, activeReleaseId: string | null): Promise<{ ok: boolean; message: string }> {
  if (!releaseId) return { ok: false, message: "releaseId is required." };
  // Never rewrite the running release's binary (ETXTBSY) — it's already installed.
  if (releaseId === activeReleaseId) {
    return { ok: false, message: `Release "${releaseId}" is the active release — already installed.` };
  }

  const src = `${DOWNLOADS_DIR}/${releaseId}`;
  const manifest = await readManifest(src);
  if (!manifest) {
    return { ok: false, message: `No manifest.json found under ${src}. Place the extracted release there first (e.g. via kubectl cp), then retry install.` };
  }
  // Stage into a temp dir and rename it into place, so an existing release
  // dir is swapped whole and its binary is never opened for write.
  const dest = releasePath(releaseId);
  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = `${dest}.tmp-${stamp}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  // Copy content rather than rename(). `docker cp` / `kubectl cp` typically
  // land files owned by root inside the container, and rename() needs
  // write+execute on the *source* directory (to unlink the entry) as well
  // as the destination — which the nonroot supervisor process doesn't have
  // for a root-owned /data/downloads/<id>. Copying only needs read access
  // to the source file and write access to the destination, both of which
  // the supervisor already has.
  //
  // Verify the *copy*, not the source: one kernel-side copy + one streaming
  // hash from page cache, instead of hashing the ~96MB source into memory,
  // copying, then hashing the copy again on activate. Checking the copy also
  // closes the window where the app-writable downloads dir could change
  // between a check and the copy. The hash is remembered (see
  // rememberVerified) so the activate that follows skips re-hashing.
  const t0 = performance.now();
  const tmpBin = `${tmp}/${manifest.artifact.name}`;
  await Bun.write(tmpBin, Bun.file(`${src}/${manifest.artifact.name}`));
  const sha = await sha256File(tmpBin);
  if (sha !== manifest.artifact.sha256) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, message: `Artifact checksum mismatch for release "${releaseId}" in ${src} — refusing to install.` };
  }
  await Bun.write(`${tmp}/manifest.json`, Bun.file(`${src}/manifest.json`));
  await chmod(tmpBin, 0o755);
  console.log(`[supervisor] install ${releaseId}: copied+verified binary in ${Math.round(performance.now() - t0)}ms`);

  // Copy the migrations folder alongside the binary — the compiled app
  // resolves migrations relative to process.execPath (db/index.ts), so an
  // update release without them can't start. The bootstrap path copies these
  // too (supervisor/bootstrap.ts); keep them in sync.
  if (existsSync(`${src}/migrations`)) {
    await cp(`${src}/migrations`, `${tmp}/migrations`, { recursive: true });
  } else if (existsSync(BOOTSTRAP_MIGRATIONS)) {
    // Legacy tarballs predate migrations being shipped — fall back to the
    // migrations baked into the image so older releases can still install.
    await cp(BOOTSTRAP_MIGRATIONS, `${tmp}/migrations`, { recursive: true });
  }

  if (existsSync(dest)) {
    const old = `${dest}.old-${stamp}`;
    await rename(dest, old);
    await rename(tmp, dest);
    await rm(old, { recursive: true, force: true }).catch(() => {});
  } else {
    await rename(tmp, dest);
  }
  // Renaming the parent dir keeps the file's inode + mtime, so the
  // fingerprint taken now is what activate will see.
  await rememberVerified(`${dest}/${manifest.artifact.name}`, sha);

  return { ok: true, message: `Installed release "${releaseId}". Run "activate ${releaseId}" to switch to it.` };
}

export async function installArchive(releaseId: string, tarballPath: string, activeReleaseId: string | null): Promise<{ ok: boolean; message: string }> {
  if (!releaseId) return { ok: false, message: "releaseId is required." };
  if (releaseId === activeReleaseId) {
    return { ok: false, message: `Release "${releaseId}" is the active release — already installed.` };
  }
  if (!tarballPath) return { ok: false, message: "tarball path is required." };

  const tarballFile = Bun.file(tarballPath);
  if (!(await tarballFile.exists())) {
    return { ok: false, message: `Tarball not found at "${tarballPath}".` };
  }
  const src = `${DOWNLOADS_DIR}/${releaseId}`;
  await mkdir(src, { recursive: true });

  const t0 = performance.now();
  const archive = new Bun.Archive(await tarballFile.arrayBuffer());
  const entryCount = await archive.extract(src);
  console.log(`[supervisor] install-archive ${releaseId}: extracted ${entryCount} entries in ${Math.round(performance.now() - t0)}ms`);
  if (entryCount === 0) {
    return { ok: false, message: `Archive "${tarballPath}" extracted 0 entries — nothing to install.` };
  }

  return installRelease(releaseId, activeReleaseId);
}
