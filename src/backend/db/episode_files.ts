import { and, eq, desc, sql } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';

export interface EpisodeFileRow {
  id: number;
  show_id: string;
  season_number: number;
  episode_number: number;
  file_path: string;
  original_name: string;
  file_size: number | null;
  source_kind: string;
  release_title: string | null;
  indexer_name: string | null;
  publish_date: string | null;
  imported_at: string | null;
  is_current: number;
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
  probed_at: string | null;
}

/** Media probe output folded into DB column shape (see schema.episodeFiles). */
export type FileMediaColumns = {
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
};

export type RecordEpisodeFileInput = {
  showId: string;
  season: number;
  episode: number;
  filePath: string;
  originalName?: string;
  fileSize?: number | null;
  sourceKind?: 'release' | 'import';
  releaseTitle?: string | null;
  indexerName?: string | null;
  publishDate?: string | null;
  /** Probed media info (from media_probe.ts) attached at record time when
   *  available. Also usable as a plain "store these media columns" input. */
  media?: Partial<FileMediaColumns> | null;
};

/**
 * Backfill for upgrades: rows the DB already had file_path on before the
 * episode_files table existed (or where records were lost). Creates one
 * provenance row per episode that has a file on disk but no current
 * episode_files row, tagged as a plain 'import' (we can't reconstruct the
 * original release for legacy data). Idempotent - only fills gaps.
 */
export function backfillEpisodeFiles(self: DatabaseManager) {
  const episodes = self.db.query(`
    SELECT e.show_id, e.season_number, e.episode_number, e.file_path
    FROM episodes e
    WHERE e.file_path IS NOT NULL AND e.file_path != ''
  `).all() as { show_id: string; season_number: number; episode_number: number; file_path: string }[];

  let filled = 0;
  for (const ep of episodes) {
    const existing = self.drizz
      .select({ id: schema.episodeFiles.id })
      .from(schema.episodeFiles)
      .where(and(
        eq(schema.episodeFiles.show_id, ep.show_id),
        eq(schema.episodeFiles.season_number, ep.season_number),
        eq(schema.episodeFiles.episode_number, ep.episode_number),
        eq(schema.episodeFiles.is_current, 1),
      ))
      .get();
    if (existing) continue;

    // Try to attach provenance from a matching historical grab.
    type GrabRow = { release_title: string | null; indexer_name: string | null; publish_date: string | null };
    let grab: GrabRow | null = null;
    const grabRow = self.db.query(`
      SELECT release_title, indexer_name, publish_date
      FROM grabbed_releases
      WHERE show_id = ? AND season_number = ? AND episode_number = ?
      ORDER BY id DESC LIMIT 1
    `).get(ep.show_id, ep.season_number, ep.episode_number) as GrabRow | undefined;
    grab = grabRow ?? null;

    recordEpisodeFile(self, {
      showId: ep.show_id,
      season: ep.season_number,
      episode: ep.episode_number,
      filePath: ep.file_path,
      originalName: ep.file_path.split(/[\\/]/).pop() ?? ep.file_path,
      sourceKind: grab ? 'release' : 'import',
      releaseTitle: grab?.release_title ?? null,
      indexerName: grab?.indexer_name ?? null,
      publishDate: grab?.publish_date ?? null,
    });
    filled++;
  }
  return filled;
}

/**
 * Records that `filePath` is now the on-disk file for the given episode.
 * Marks any previous live row for (show, season, episode) as superseded and
 * inserts the new one as is_current=1, so the table keeps upgrade history.
 * A single import of a pack that maps to N episodes calls this N times.
 */
export function recordEpisodeFile(self: DatabaseManager, input: RecordEpisodeFileInput) {
  self.drizz
    .update(schema.episodeFiles)
    .set({ is_current: 0 })
    .where(and(
      eq(schema.episodeFiles.show_id, input.showId),
      eq(schema.episodeFiles.season_number, input.season),
      eq(schema.episodeFiles.episode_number, input.episode),
      sql`${schema.episodeFiles.is_current} = 1`,
    ))
    .run();

  const m = input.media ?? null;
  return self.drizz
    .insert(schema.episodeFiles)
    .values({
      show_id: input.showId,
      season_number: input.season,
      episode_number: input.episode,
      file_path: input.filePath,
      original_name: input.originalName ?? input.filePath.split(/[\\/]/).pop() ?? input.filePath,
      file_size: input.fileSize ?? null,
      source_kind: input.sourceKind ?? 'import',
      release_title: input.releaseTitle ?? null,
      indexer_name: input.indexerName ?? null,
      publish_date: input.publishDate ?? null,
      is_current: 1,
      container: m?.container ?? null,
      video_width: m?.video_width ?? null,
      video_height: m?.video_height ?? null,
      video_codec: m?.video_codec ?? null,
      video_fps: m?.video_fps ?? null,
      hdr: m?.hdr ?? null,
      audio_codec: m?.audio_codec ?? null,
      audio_channels: m?.audio_channels ?? null,
      duration_seconds: m?.duration_seconds ?? null,
      bitrate_kbps: m?.bitrate_kbps ?? null,
      probed_at: m ? sql`(datetime('now'))` : null,
    })
    .run();
}

/**
 * Update the probed media columns on an existing episode_files row (used for
 * backfill / re-probe when the file was recorded before probing existed, or
 * when a re-scan finds the file changed). No-op when rowId is null.
 */
export function updateEpisodeFileMedia(self: DatabaseManager, rowId: number, media: Partial<FileMediaColumns>) {
  return self.drizz
    .update(schema.episodeFiles)
    .set({
      ...(media.container !== undefined ? { container: media.container } : {}),
      ...(media.video_width !== undefined ? { video_width: media.video_width } : {}),
      ...(media.video_height !== undefined ? { video_height: media.video_height } : {}),
      ...(media.video_codec !== undefined ? { video_codec: media.video_codec } : {}),
      ...(media.video_fps !== undefined ? { video_fps: media.video_fps } : {}),
      ...(media.hdr !== undefined ? { hdr: media.hdr } : {}),
      ...(media.audio_codec !== undefined ? { audio_codec: media.audio_codec } : {}),
      ...(media.audio_channels !== undefined ? { audio_channels: media.audio_channels } : {}),
      ...(media.duration_seconds !== undefined ? { duration_seconds: media.duration_seconds } : {}),
      ...(media.bitrate_kbps !== undefined ? { bitrate_kbps: media.bitrate_kbps } : {}),
      probed_at: sql`(datetime('now'))`,
    })
    .where(eq(schema.episodeFiles.id, rowId))
    .run();
}

/**
 * Update the on-disk path of an episode_files row (used when a file is
 * renamed/moved in place by organize). The original_name is preserved - that
 * is the *release* name, which should not change just because the file was
 * relocated.
 */
export function updateEpisodeFileRowPath(self: DatabaseManager, rowId: number, filePath: string) {
  return self.drizz
    .update(schema.episodeFiles)
    .set({ file_path: filePath })
    .where(eq(schema.episodeFiles.id, rowId))
    .run();
}

/**
 * Rows on disk that have never been probed (media columns null) but carry a
 * file path - the backfill target after the probe feature ships. Ordered by
 * show so the backfill can be chunked per show if needed.
 */
export function listUnprobedEpisodeFiles(self: DatabaseManager): EpisodeFileRow[] {
  return self.drizz
    .select()
    .from(schema.episodeFiles)
    .where(and(
      eq(schema.episodeFiles.is_current, 1),
      sql`${schema.episodeFiles.container} IS NULL`,
    ))
    .orderBy(desc(schema.episodeFiles.id))
    .all() as EpisodeFileRow[];
}

/** The live file for one episode, if any. */
export function getCurrentEpisodeFile(
  self: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
): EpisodeFileRow | null {
  const row = self.drizz
    .select()
    .from(schema.episodeFiles)
    .where(and(
      eq(schema.episodeFiles.show_id, showId),
      eq(schema.episodeFiles.season_number, season),
      eq(schema.episodeFiles.episode_number, episode),
      eq(schema.episodeFiles.is_current, 1),
    ))
    .get();
  return (row as EpisodeFileRow | undefined) ?? null;
}

/** All files ever recorded for a show, newest live row first. */
export function listEpisodeFilesByShow(self: DatabaseManager, showId: string): EpisodeFileRow[] {
  return self.drizz
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.show_id, showId))
    .orderBy(
      desc(schema.episodeFiles.is_current),
      desc(schema.episodeFiles.imported_at),
      desc(schema.episodeFiles.id),
    )
    .all() as EpisodeFileRow[];
}

/** The live files across a set of episodes, keyed by `season:episode`. */
export function getCurrentEpisodeFilesByShow(self: DatabaseManager, showId: string): Map<string, EpisodeFileRow> {
  const rows = self.drizz
    .select()
    .from(schema.episodeFiles)
    .where(and(
      eq(schema.episodeFiles.show_id, showId),
      eq(schema.episodeFiles.is_current, 1),
    ))
    .all() as EpisodeFileRow[];
  const map = new Map<string, EpisodeFileRow>();
  for (const row of rows) map.set(`${row.season_number}:${row.episode_number}`, row);
  return map;
}

/** All live files across every show (used by the scanner/episode APIs). */
export function listAllCurrentEpisodeFiles(self: DatabaseManager): EpisodeFileRow[] {
  return self.drizz
    .select()
    .from(schema.episodeFiles)
    .where(eq(schema.episodeFiles.is_current, 1))
    .all() as EpisodeFileRow[];
}