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
}

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
    })
    .run();
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