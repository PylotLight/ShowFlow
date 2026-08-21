import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { DatabaseManager } from '../db';
import * as schema from '../db/schema';
import { normalizeShowTitle } from '../db/shows';
import { FilenameParser } from '../parser';
import { probeMediaFile, mediaFromStoredRow, type MediaProbeInfo } from './media_probe';
import { qualityEngine } from './quality_engine';

export interface EpisodeDuplicateFile {
  path: string;
  name: string;
  size: number | null;
  onDisk: boolean;
  isCurrent: boolean;
  rowId: number | null;
  score: number;
  quality: string | null;
  media: {
    container?: string | null;
    videoHeight?: number | null;
    videoWidth?: number | null;
    videoCodec?: string | null;
    hdr?: boolean;
    audioCodec?: string | null;
    bitrateKbps?: number | null;
  } | null;
}

export interface EpisodeDuplicateGroup {
  showId: string;
  season: number;
  episode: number;
  title: string | null;
  files: EpisodeDuplicateFile[];
  /** Path of the highest-scoring file that exists on disk. */
  best: string | null;
  onDiskCount: number;
  trackedCount: number;
}

function mediaColumns(probe: MediaProbeInfo | null) {
  if (!probe) return null;
  return {
    container: probe.container ?? null,
    videoHeight: probe.video?.height ?? null,
    videoWidth: probe.video?.width ?? null,
    videoCodec: probe.video?.codec ?? null,
    hdr: probe.video?.hdr ?? null,
    audioCodec: probe.audio?.[0]?.codec ?? null,
    bitrateKbps: probe.overallBitrate ? Math.round(probe.overallBitrate / 1000) : null,
  };
}

/** The library root(s) configured for a show (profile root or library type). */
function showRoots(db: DatabaseManager, showId: string): string[] {
  const show = db.getShow(showId) as any;
  if (!show) return [];
  const roots: string[] = [];
  if (show.root_folder_path) roots.push(show.root_folder_path);
  const profileRoot = (db.listShowProfiles().find((p: any) => p.id === show.show_profile_id) as any)?.root_folder_path;
  if (profileRoot) roots.push(profileRoot);
  const libType = (db.listLibraryTypes().find((lt: any) => lt.id === show.library_type_id) as any);
  if (libType?.root_folder_path) roots.push(libType.root_folder_path);
  return [...new Set(roots.filter(Boolean))];
}

/**
 * Which top-level subfolders of a library root should be scanned for this
 * show: the canonical (sanitized-title) folder, any folder whose name
 * normalizes to the same key, and any folder already holding the show's
 * tracked files. This is what catches episodes parked in variant-named
 * folders (e.g. "Re - ZERO, Starting Life in Another World").
 */
async function candidateFolders(root: string, db: DatabaseManager, showId: string, showTitle: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  const trackedPrefixes = new Set<string>();
  for (const row of db.listEpisodeFilesByShow(showId)) {
    if (!row.file_path.startsWith(root)) continue;
    const rel = row.file_path.slice(root.length).replace(/^[/\\]+/, '');
    const first = rel.split(/[/\\]/)[0];
    if (first) trackedPrefixes.add(first);
  }
  for (const ep of db.listAllEpisodes(showId)) {
    if (!ep.file_path?.startsWith(root)) continue;
    const rel = ep.file_path.slice(root.length).replace(/^[/\\]+/, '');
    const first = rel.split(/[/\\]/)[0];
    if (first) trackedPrefixes.add(first);
  }

  const key = normalizeShowTitle(showTitle);
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const matchesTitle = key && normalizeShowTitle(e.name) === key;
    const matchesTracked = trackedPrefixes.has(e.name);
    if (!matchesTitle && !matchesTracked) continue;
    const full = path.join(root, e.name);
    if (!seen.has(full)) {
      seen.add(full);
      out.push(full);
    }
  }
  return out;
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

function parseEpisode(
  filename: string,
): { show: string; season: number; episodes: number[] } | null {
  const parsed = new FilenameParser().parse(filename);
  if (!parsed || parsed.season === undefined || !parsed.episodes?.length) return null;
  return { show: parsed.show, season: parsed.season, episodes: parsed.episodes };
}

function titleMatches(parsedTitle: string, showTitle: string): boolean {
  const norm = (v: string) =>
    v.normalize('NFKC').replace(/[._]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const a = norm(parsedTitle);
  const b = norm(showTitle);
  return a === b || a.includes(b) || b.includes(a);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect messy episodes for one show: every (season, episode) that has more
 * than one file on disk, or whose DB-tracked file is not the best on-disk
 * copy, or that has stale episode_files rows pointing at missing files.
 * Files are scored with the quality engine (probe or stored media when
 * available) so the best copy can be kept.
 */
export async function detectEpisodeDuplicates(db: DatabaseManager, showId: string): Promise<EpisodeDuplicateGroup[]> {
  const show = db.getShow(showId) as any;
  if (!show) return [];
  const profileId = show.profile ?? 'standard';

  // key: "season:episode" -> candidate files (path -> entry)
  const groups = new Map<string, Map<string, EpisodeDuplicateFile>>();
  const keyFor = (s: number, e: number) => `${s}:${e}`;

  const ensureGroup = (season: number, ep: number) => {
    const key = keyFor(season, ep);
    let map = groups.get(key);
    if (!map) {
      map = new Map();
      groups.set(key, map);
    }
    return map;
  };

  // Seed with DB rows (so stale/missing paths and the current-tracked path
  // are always represented, even when the file no longer exists).
  for (const row of db.listEpisodeFilesByShow(showId)) {
    const map = ensureGroup(row.season_number, row.episode_number);
    const entry = map.get(row.file_path);
    if (entry) {
      entry.rowId = entry.rowId ?? row.id;
      entry.isCurrent = entry.isCurrent || !!row.is_current;
      if (row.is_current) entry.score = Math.max(entry.score, scoreRow(row, profileId));
      continue;
    }
    const onDisk = await exists(row.file_path);
    const score = onDisk ? scoreRow(row, profileId) : 0;
    map.set(row.file_path, {
      path: row.file_path,
      name: path.basename(row.file_path),
      size: row.file_size,
      onDisk,
      isCurrent: !!row.is_current,
      rowId: row.id,
      score,
      quality: null,
      media: onDisk ? mediaFromStoredRow(row) && mediaColumnsStored(row) : null,
    });
  }

  // Walk the show's candidate folders, parse filenames, add on-disk files.
  for (const root of showRoots(db, showId)) {
    for (const folder of await candidateFolders(root, db, showId, show.title)) {
      for (const file of await listFiles(folder)) {
        const filename = path.basename(file);
        const parsed = parseEpisode(filename);
        if (!parsed) continue;
        if (!titleMatches(parsed.show, show.title)) continue;
        for (const epNum of parsed.episodes) {
          const map = ensureGroup(parsed.season, epNum);
          const existing = map.get(file);
          if (existing) continue;
          let size: number | null = null;
          try {
            const st = await fs.promises.stat(file);
            size = st.size;
          } catch {}
          const row = db.listEpisodeFilesByShow(showId).find(
            (r) => r.file_path === file && r.season_number === parsed.season && r.episode_number === epNum && r.is_current,
          );
          let score = 0;
          let quality = null;
          let media = null;
          if (row && row.container) {
            score = scoreRow(row, profileId);
            quality = qualityNameOfScore(row, profileId);
            media = mediaColumnsStored(row);
          } else {
            const probe = await probeMediaFile(file);
            if (probe) {
              const rel = qualityEngine.getReleaseScoreFromMedia(probe, profileId);
              score = rel.totalScore;
              quality = rel.qualityName ?? null;
            }
            media = mediaColumns(probe);
          }
          map.set(file, {
            path: file,
            name: filename,
            size,
            onDisk: true,
            isCurrent: !!row,
            rowId: row?.id ?? null,
            score,
            quality,
            media,
          });
        }
      }
    }
  }

  const out: EpisodeDuplicateGroup[] = [];
  for (const [key, files] of groups) {
    const split = key.split(':');
    const season = Number(split[0]);
    const episode = Number(split[1]);
    const arr = [...files.values()].sort((a, b) => b.score - a.score);

    const onDisk = arr.filter((f) => f.onDisk);
    const trackedCurrent = arr.filter((f) => f.isCurrent);
    const best = onDisk[0]?.path ?? null;

    // A group is "messy" when:
    //  - more than one file exists on disk for the episode, or
    //  - the tracked current file is not the best on-disk copy, or
    //  - tracked rows point at files that no longer exist (stale), or
    //  - multiple files point at the same path (duplicate DB rows).
    const duplicateDisk = onDisk.length > 1;
    const bestMismatch = best && trackedCurrent.length > 0 && trackedCurrent.some((f) => f.path !== best);
    const staleRows = arr.some((f) => !f.onDisk && (f.isCurrent || f.rowId != null));
    const dupPaths = arr.length > new Set(arr.map((f) => f.path)).size;

    if (!duplicateDisk && !bestMismatch && !staleRows && !dupPaths) continue;

    const ep = (db.listAllEpisodes(showId) as any[]).find(
      (e) => e.season_number === season && e.episode_number === episode,
    );

    out.push({
      showId,
      season,
      episode,
      title: ep?.title ?? null,
      files: arr,
      best,
      onDiskCount: onDisk.length,
      trackedCount: arr.filter((f) => f.rowId != null).length,
    });
  }

  return out;
}

function scoreRow(row: EpisodeFileRowLike, profileId: string): number {
  const media = mediaFromStoredRow(row);
  return media ? qualityEngine.getReleaseScoreFromMedia(media, profileId).totalScore : 0;
}

function qualityNameOfScore(row: EpisodeFileRowLike, profileId: string): string | null {
  const media = mediaFromStoredRow(row);
  return media ? qualityEngine.getReleaseScoreFromMedia(media, profileId).qualityName ?? null : null;
}

function mediaColumnsStored(row: EpisodeFileRowLike) {
  if (!row.container && row.video_width == null && row.video_height == null) return null;
  return {
    container: row.container ?? null,
    videoHeight: row.video_height ?? null,
    videoWidth: row.video_width ?? null,
    videoCodec: row.video_codec ?? null,
    hdr: !!row.hdr,
    audioCodec: row.audio_codec ?? null,
    bitrateKbps: row.bitrate_kbps ?? null,
  };
}

type EpisodeFileRowLike = {
  container: string | null;
  video_width: number | null;
  video_height: number | null;
  video_codec: string | null;
  video_fps: number | null;
  hdr: number | null;
  audio_codec: string | null;
  audio_channels: number | null;
  duration_seconds: number | null;
  bitrate_kbps: number | null;
  file_size: number | null;
};

/**
 * Resolve a messy episode: keep `keepPath` (must be one of the group's files
 * that exists on disk), delete every other on-disk file for the episode,
 * repoint episodes.file_path, and tidy episode_files rows - the kept file
 * becomes current, rows for deleted files are removed.
 */
export async function resolveEpisodeDuplicate(
  db: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
  keepPath: string,
): Promise<{ deleted: number; kept: string }> {
  const groups = await detectEpisodeDuplicates(db, showId);
  const group = groups.find((g) => g.season === season && g.episode === episode);
  if (!group) throw new Error(`No duplicate group found for S${season}E${episode}`);
  const keep = group.files.find((f) => f.path === keepPath);
  if (!keep) throw new Error('Keep path is not a file for this episode');
  if (!keep.onDisk) throw new Error('Keep path does not exist on disk');

  const deleted: string[] = [];
  for (const f of group.files) {
    if (f.path === keepPath) continue;
    if (f.onDisk) {
      try {
        await fs.promises.unlink(f.path);
        deleted.push(f.path);
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
    // Remove DB rows that point at the deleted/missing file.
    db.drizz.delete(schema.episodeFiles)
      .where(sql`${schema.episodeFiles.show_id} = ${showId} AND ${schema.episodeFiles.season_number} = ${season} AND ${schema.episodeFiles.episode_number} = ${episode} AND ${schema.episodeFiles.file_path} = ${f.path}`)
      .run();
  }

  // Make the kept file the live one: demote any other current row, insert a
  // fresh current row (idempotent via upsert-style demote+insert).
  db.drizz.update(schema.episodeFiles)
    .set({ is_current: 0 })
    .where(sql`${schema.episodeFiles.show_id} = ${showId} AND ${schema.episodeFiles.season_number} = ${season} AND ${schema.episodeFiles.episode_number} = ${episode} AND ${schema.episodeFiles.is_current} = 1`)
    .run();

  const keptName = keep.name;
  let size: number | null = null;
  try {
    size = (await fs.promises.stat(keep.path)).size;
  } catch {}
  db.recordEpisodeFile({
    showId,
    season,
    episode,
    filePath: keep.path,
    originalName: keptName,
    fileSize: size,
    sourceKind: 'import',
  });
  db.updateEpisodeFilePath(showId, season, episode, keep.path);

  db.logEvent({
    type: 'dedup',
    entityType: 'episode',
    entityId: `${showId}:${season}:${episode}`,
    message: `Resolved duplicate S${season}E${episode}: kept "${keptName}"${deleted.length ? `, deleted ${deleted.length} duplicate file(s)` : ''}`,
    metadata: { showId, season, episode, kept: keep.path, deleted },
  });

  return { deleted: deleted.length, kept: keep.path };
}