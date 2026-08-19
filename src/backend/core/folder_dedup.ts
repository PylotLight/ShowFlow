import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { DatabaseManager } from "../db";
import * as schema from "../db/schema";
import { normalizeShowTitle } from "../db/shows";

export interface FolderDuplicateGroup {
  key: string;
  rootFolder: string;
  canonicalFolder: string;
  folders: {
    path: string;
    name: string;
    fileCount: number;
    currentFileCount: number;
    showId: string | null;
    showTitle: string | null;
  }[];
  wouldMove: { from: string; to: string }[];
}

/** Files under a directory, recursively, as absolute paths. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** The library roots configured for shows. */
function libraryRoots(db: DatabaseManager): string[] {
  return [
    ...new Set([
      ...db.listShowProfiles().map(p => p.root_folder_path).filter(Boolean),
      ...db.listLibraryTypes().map((t: any) => t.root_folder_path).filter(Boolean),
    ]),
  ];
}

/**
 * Detect top-level folders inside the library roots whose names normalize to
 * the same key ("HELL MODE - The Hardcore..." vs "HELL MODE: The Hardcore...",
 * "Re-ZERO -Starting Life..." vs "Re: ZERO, Starting Life..."). Each group
 * names a canonical folder (the one that best matches the tracked show) and
 * the other folders become consolidation candidates.
 */
export async function detectOverlappingFolders(db: DatabaseManager): Promise<FolderDuplicateGroup[]> {
  const shows = db.listShows() as any[];
  const showByNorm = new Map<string, any>();
  for (const s of shows) {
    const norm = normalizeShowTitle(s.title ?? "");
    if (norm && !showByNorm.has(norm)) showByNorm.set(norm, s);
  }

  const currentFiles = db.listAllCurrentEpisodeFiles();
  const roots = libraryRoots(db);

  // For each library root, map show folder path -> per-show current file counts.
  const countsByFolder = new Map<string, Map<string, number>>();
  for (const f of currentFiles) {
    if (!f.file_path) continue;
    for (const root of roots) {
      const prefix = `${root}${path.sep}`;
      if (!f.file_path.startsWith(prefix)) continue;
      const rel = f.file_path.slice(prefix.length);
      const sep = rel.indexOf(path.sep);
      if (sep < 0) break;
      const folder = prefix + rel.slice(0, sep);
      let byShow = countsByFolder.get(folder);
      if (!byShow) {
        byShow = new Map<string, number>();
        countsByFolder.set(folder, byShow);
      }
      byShow.set(f.show_id, (byShow.get(f.show_id) ?? 0) + 1);
      break;
    }
  }

  const groups: FolderDuplicateGroup[] = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => path.join(root, e.name));

    const byKey = new Map<string, string[]>();
    for (const folder of folders) {
      const key = normalizeShowTitle(path.basename(folder));
      if (!key) continue;
      const list = byKey.get(key) ?? [];
      list.push(folder);
      byKey.set(key, list);
    }

    for (const [key, groupFolders] of byKey) {
      if (groupFolders.length < 2) continue;

      const show = showByNorm.get(key) ?? null;

      const stats = groupFolders.map(async folder => {
        const byShow = countsByFolder.get(folder) ?? new Map<string, number>();
        const currentCount = [...byShow.values()].reduce((a, b) => a + b, 0);
        const showId = show && byShow.has(show.id)
          ? show.id
          : (byShow.size > 0 ? byShow.keys().next().value! : null);
        const fileCount = (await listFiles(folder)).length;
        return {
          path: folder,
          name: path.basename(folder),
          fileCount,
          currentFileCount: currentCount,
          showId,
          showTitle: showId ? ((db.getShow(showId) as any)?.title ?? null) : null,
        };
      });
      const resolved = await Promise.all(stats);

      // Canonical = the folder the tracked show actually points into (and
      // which holds the most files), else the most complete folder.
      const scored = resolved.map(s => ({
        ...s,
        score:
          (s.showId === show?.id ? 100000 : 0) +
          (show && s.name === show.title ? 50000 : 0) +
          s.currentFileCount * 1000 +
          s.fileCount,
      }));
      scored.sort((a, b) => b.score - a.score);
      const canonical = scored[0]!;
      const others = scored.filter(s => s.path !== canonical.path);

      // Build move preview: preserve each file's subpath under its folder.
      const wouldMove: { from: string; to: string }[] = [];
      for (const other of others) {
        const files = await listFiles(other.path);
        for (const file of files) {
          const rel = path.relative(other.path, file);
          wouldMove.push({ from: file, to: path.join(canonical.path, rel) });
        }
      }
      if (wouldMove.length === 0) continue;

      groups.push({
        key,
        rootFolder: root,
        canonicalFolder: canonical.path,
        folders: scored.map(({ score: _score, ...rest }) => rest),
        wouldMove,
      });
    }
  }

  return groups;
}

/**
 * Consolidate one overlapping-folder group: physically move every file out of
 * the non-canonical folders into the canonical folder (preserving subpaths),
 * rewrite DB paths, then remove the now-empty duplicate folders.
 *
 * The group is re-derived from disk rather than trusting the client, so this
 * only ever operates on the current on-disk state.
 */
export async function consolidateOverlappingFolders(
  db: DatabaseManager,
  rootFolder: string,
  key: string,
): Promise<{ moved: number; removedFolders: string[] }> {
  const groups = await detectOverlappingFolders(db);
  const group = groups.find(g => g.rootFolder === rootFolder && g.key === key);
  if (!group) throw new Error("No overlapping folders match that group anymore");

  const removedFolders: string[] = [];
  let moved = 0;
  let alreadyPresent = 0;

  for (const other of group.folders) {
    if (other.path === group.canonicalFolder) continue;
    const files = await listFiles(other.path);
    for (const file of files) {
      const rel = path.relative(other.path, file);
      const target = path.join(group.canonicalFolder, rel);
      if (fs.existsSync(target)) {
        // Same file already lives in the canonical folder; just repoint rows.
        alreadyPresent++;
        repointDbRows(db, file, target);
        continue;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.promises.rename(file, target);
      } catch (err: any) {
        if (err.code === "EXDEV") {
          await fs.promises.copyFile(file, target);
          await fs.promises.unlink(file);
        } else {
          throw err;
        }
      }
      moved++;
      repointDbRows(db, file, target);
    }

    // Sweep any remaining DB rows pointing under the old folder (rows whose
    // on-disk name differs from the stored path, e.g. a manual rename).
    const prefix = `${other.path}${path.sep}`;
    db.drizz.update(schema.episodeFiles)
      .set({ file_path: sql`${group.canonicalFolder} || substr(${schema.episodeFiles.file_path}, ${prefix.length})` })
      .where(sql`substr(${schema.episodeFiles.file_path}, 1, ${prefix.length}) = ${prefix}`)
      .run();
    db.drizz.update(schema.episodes)
      .set({ file_path: sql`${group.canonicalFolder} || substr(${schema.episodes.file_path}, ${prefix.length})` })
      .where(sql`substr(${schema.episodes.file_path}, 1, ${prefix.length}) = ${prefix}`)
      .run();

    try {
      await fs.promises.rm(other.path, { recursive: true, force: true });
      removedFolders.push(other.path);
    } catch {
      // Folder may still hold non-media files; leave it.
    }
  }

  const show = db.listShows().find((s: any) => normalizeShowTitle(s.title ?? "") === key) as any;
  db.logEvent({
    type: "dedup",
    entityType: "folder",
    entityId: key,
    message: `Consolidated overlapping folders under ${rootFolder}: moved ${moved} file(s) into "${path.basename(group.canonicalFolder)}"${alreadyPresent ? ` (${alreadyPresent} already present)` : ""}`,
    metadata: { rootFolder, key, moved, removedFolders, showId: show?.id ?? null },
  });

  return { moved, removedFolders };
}

function repointDbRows(db: DatabaseManager, oldPath: string, newPath: string) {
  db.drizz.update(schema.episodeFiles)
    .set({ file_path: newPath })
    .where(sql`${schema.episodeFiles.file_path} = ${oldPath}`)
    .run();
  db.drizz.update(schema.episodes)
    .set({ file_path: newPath })
    .where(sql`${schema.episodes.file_path} = ${oldPath}`)
    .run();
}