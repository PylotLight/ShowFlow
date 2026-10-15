import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Disk retention for self-update artifacts on the /data PVC.
 *
 * Every update leaves ~100MB in /data/releases/<id> (binary + migrations)
 * and another ~130MB in /data/downloads/<id> (release.tar.gz + its
 * extracted copy), and nothing ever deleted them — dozens of releases in,
 * that's GBs of dead binaries. Rolling back from the Updates panel re-runs
 * install (re-downloads), so only releases the supervisor might still
 * start need to stay on disk.
 *
 * Always kept: the active release, lastKnownGood, any in-progress
 * candidate (supervisor state.json), the staged-but-not-activated pending
 * update, the release this process is running from, plus the `keepRecent`
 * newest entries by mtime as a safety margin.
 */
export const DEFAULT_KEEP_RECENT_RELEASES = 3;

export interface ReleaseRetentionOptions {
  dataDir?: string;
  keepRecent?: number;
  /** Extra release ids that must survive (pending staged update, etc). */
  protectIds?: (string | null | undefined)[];
}

export interface ReleaseRetentionResult {
  deleted: string[];
  freedBytes: number;
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await readdir(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) total += await dirSize(full);
      else total += (await stat(full).catch(() => null))?.size ?? 0;
    }
  } catch {}
  return total;
}

export async function pruneOldReleases(opts: ReleaseRetentionOptions = {}): Promise<ReleaseRetentionResult> {
  const dataDir = opts.dataDir ?? process.env.SHOWFLOW_DATA_DIR ?? '/data';
  const keepRecent = Math.max(1, opts.keepRecent ?? DEFAULT_KEEP_RECENT_RELEASES);
  const result: ReleaseRetentionResult = { deleted: [], freedBytes: 0 };

  // Only act on a supervisor-managed PVC. No state file = dev / bare binary /
  // tests, where these dirs aren't ours to clean.
  const stateFile = join(dataDir, 'state', 'active.json');
  if (!existsSync(stateFile)) return result;

  let state: { active?: string | null; lastKnownGood?: string | null; candidate?: string | null } = {};
  try {
    state = await Bun.file(stateFile).json();
  } catch {
    // Unreadable state: we can't tell what's live, so don't delete anything.
    return result;
  }

  const protect = new Set<string>(
    [state.active, state.lastKnownGood, state.candidate, ...(opts.protectIds ?? [])]
      .filter((x): x is string => typeof x === 'string' && x.length > 0),
  );
  // The release this very process runs from (/data/releases/<id>/showflow).
  const releasesDir = join(dataDir, 'releases');
  const ownDir = dirname(process.execPath);
  if (dirname(ownDir) === releasesDir) protect.add(basename(ownDir));

  for (const sub of ['releases', 'downloads']) {
    const root = join(dataDir, sub);
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      continue;
    }
    const withMtime = await Promise.all(names.map(async (name) => ({
      name,
      mtime: (await stat(join(root, name)).catch(() => null))?.mtimeMs ?? 0,
    })));
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const recent = new Set(withMtime.slice(0, keepRecent).map(e => e.name));

    for (const { name } of withMtime) {
      if (protect.has(name) || recent.has(name)) continue;
      const full = join(root, name);
      const size = await dirSize(full);
      try {
        await rm(full, { recursive: true, force: true });
        result.deleted.push(`${sub}/${name}`);
        result.freedBytes += size;
      } catch {
        // Permission / race — leave it for next time.
      }
    }
  }
  return result;
}
