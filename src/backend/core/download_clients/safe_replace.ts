import { rename, unlink, copyFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Crash/failure-safe "put this new file in the library, retiring these old
 * ones" for the import pipeline.
 *
 * The old importer unlinked the existing library file FIRST and then moved
 * the replacement in. Any failure in between (EXDEV copy dying half way, a
 * full disk, a permission error on the destination, a DB error after the
 * move) left the episode with no file at all while the DB still pointed at
 * the deleted path. This does it the other way round:
 *
 *   1. stage   src -> `<destDir>/.<name>.showflow-tmp-<id>` (rename on the
 *              same mount; copy + fsync across mounts, src left in place)
 *   2. backup  each old file -> `.<name>.showflow-bak-<id>` next to itself
 *              (same-dir rename = atomic metadata op, no data copied)
 *   3. place   tmp -> final path (atomic rename inside destDir)
 *   4. caller updates the DB
 *   5. finalize: delete backups (+ the src copy when we copied)
 *
 * Any failure in 1-3 undoes the earlier steps before throwing; the caller
 * calls rollback() if step 4 fails. Either way the old file is back at its
 * original path, the incoming file is back in the watch folder, and the DB
 * still points at the old file.
 *
 * Staging names have no video extension and start with a dot, so the
 * library scanner never sees a half-copied file as an episode.
 */

export type CollisionMode = 'skip' | 'version' | 'overwrite';

/** fs calls used here, injectable so tests can fail any step. */
export interface ReplaceFsOps {
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  exists: (p: string) => Promise<boolean>;
  fsync: (p: string) => Promise<void>;
}

const defaultExists = async (p: string) => {
  try { await stat(p); return true; } catch { return false; }
};

const defaultFsync = async (p: string) => {
  const fh = await open(p, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
};

export const defaultFsOps: ReplaceFsOps = {
  rename: (a, b) => rename(a, b),
  copyFile: (a, b) => copyFile(a, b),
  unlink: (p) => unlink(p),
  exists: defaultExists,
  fsync: defaultFsync,
};

/** Errors where a plain rename can't work but a copy might. */
const COPY_FALLBACK_CODES = new Set(['EXDEV', 'EACCES', 'EPERM']);

export interface BeginReplaceOptions {
  /** Incoming file (watch folder). */
  src: string;
  /** Desired library path. Its directory must already exist. */
  dest: string;
  /** Existing library files this import supersedes. Missing paths are ignored. */
  replace?: string[];
  onCollision?: CollisionMode;
  ops?: Partial<ReplaceFsOps>;
  /** Copy fallback for filesystems without kernel copy (chunked stream). */
  copyFallback?: (from: string, to: string) => Promise<void>;
  log?: (msg: string) => void;
}

function stagingName(target: string, kind: 'tmp' | 'bak', id: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.showflow-${kind}-${id}`);
}

export function isSafeReplaceArtifact(filename: string): boolean {
  return /\.showflow-(tmp|bak)-[0-9a-f-]+$/i.test(path.basename(filename));
}

export class FileReplacement {
  /** Where the new file now lives. */
  readonly finalPath: string;
  private done = false;

  private constructor(
    private readonly ops: ReplaceFsOps,
    private readonly src: string,
    finalPath: string,
    /** true = src was renamed away (rollback must put it back). */
    private readonly srcConsumed: boolean,
    /** [original, backup] pairs. */
    private readonly backups: Array<[string, string]>,
    private readonly log: (msg: string) => void,
  ) {
    this.finalPath = finalPath;
  }

  /** Paths of the retired files that were actually backed up. */
  get replacedPaths(): string[] {
    return this.backups.map(([orig]) => orig);
  }

  /**
   * Stage, back up and place. Returns null when the destination is occupied
   * by an unrelated file and onCollision='skip' (nothing changed on disk).
   * Throws after restoring everything when any step fails.
   */
  static async begin(opts: BeginReplaceOptions): Promise<FileReplacement | null> {
    const ops: ReplaceFsOps = { ...defaultFsOps, ...(opts.ops ?? {}) };
    const log = opts.log ?? (() => {});
    const id = crypto.randomUUID();
    const tmp = stagingName(opts.dest, 'tmp', id);
    const srcAbs = path.resolve(opts.src);

    // 1. stage
    let srcConsumed = false;
    try {
      await ops.rename(opts.src, tmp);
      srcConsumed = true;
    } catch (err: any) {
      if (!COPY_FALLBACK_CODES.has(err?.code)) throw err;
      try {
        try {
          await ops.copyFile(opts.src, tmp);
        } catch (copyErr: any) {
          if (!opts.copyFallback || !['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'].includes(copyErr?.code)) throw copyErr;
          await opts.copyFallback(opts.src, tmp);
        }
        // Make sure the bytes are on the destination disk before we retire
        // the old file — a power cut after rename must not leave a hole.
        await ops.fsync(tmp);
      } catch (copyErr) {
        await ops.unlink(tmp).catch(() => {});
        throw copyErr;
      }
    }

    const unstage = async () => {
      if (srcConsumed) {
        await ops.rename(tmp, opts.src).catch((e) => log(`could not return staged file ${tmp} to ${opts.src}: ${e?.message ?? e}`));
      } else {
        await ops.unlink(tmp).catch(() => {});
      }
    };

    // 2. back up old files (dedupe; never "replace" the incoming file itself)
    const backups: Array<[string, string]> = [];
    const restoreBackups = async () => {
      for (const [orig, bak] of [...backups].reverse()) {
        await ops.rename(bak, orig).catch((e) => log(`RESTORE FAILED ${bak} -> ${orig}: ${e?.message ?? e}`));
      }
    };
    const seen = new Set<string>();
    try {
      for (const old of opts.replace ?? []) {
        if (!old) continue;
        const abs = path.resolve(old);
        if (seen.has(abs) || abs === srcAbs) continue;
        seen.add(abs);
        if (!(await ops.exists(old))) continue;
        const bak = stagingName(old, 'bak', id);
        await ops.rename(old, bak);
        backups.push([old, bak]);
      }
    } catch (err) {
      await restoreBackups();
      await unstage();
      throw err;
    }

    // 3. resolve collisions against whatever is left at dest, then place
    let finalPath = opts.dest;
    try {
      if (await ops.exists(opts.dest)) {
        const mode = opts.onCollision ?? 'skip';
        if (mode === 'skip') {
          await restoreBackups();
          await unstage();
          return null;
        }
        if (mode === 'version') {
          const ext = path.extname(opts.dest);
          const base = opts.dest.slice(0, opts.dest.length - ext.length);
          let n = 1;
          while (await ops.exists(`${base} (${n})${ext}`)) n++;
          finalPath = `${base} (${n})${ext}`;
        }
        // overwrite: rename() replaces atomically
      }
      await ops.rename(tmp, finalPath);
    } catch (err) {
      await restoreBackups();
      await unstage();
      throw err;
    }

    return new FileReplacement(ops, opts.src, finalPath, srcConsumed, backups, log);
  }

  /** Success: drop the backups and (copy path) the source in the watch folder. */
  async finalize(): Promise<void> {
    if (this.done) return;
    this.done = true;
    for (const [orig, bak] of this.backups) {
      await this.ops.unlink(bak).catch((e) => this.log(`could not delete backup ${bak} (of ${orig}): ${e?.message ?? e}`));
    }
    if (!this.srcConsumed) {
      await this.ops.unlink(this.src).catch((e) => this.log(`copied ${this.src} but could not remove the source: ${e?.message ?? e}`));
    }
  }

  /** Failure after placement (e.g. DB write): undo everything. */
  async rollback(): Promise<void> {
    if (this.done) return;
    this.done = true;
    if (this.srcConsumed) {
      await this.ops.rename(this.finalPath, this.src).catch((e) => this.log(`could not return ${this.finalPath} to ${this.src}: ${e?.message ?? e}`));
    } else {
      await this.ops.unlink(this.finalPath).catch(() => {});
    }
    for (const [orig, bak] of [...this.backups].reverse()) {
      await this.ops.rename(bak, orig).catch((e) => this.log(`RESTORE FAILED ${bak} -> ${orig}: ${e?.message ?? e}`));
    }
  }
}
