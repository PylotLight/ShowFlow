import { and, eq, sql } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';

export interface EpisodeMappingRow {
  id: number;
  show_id: string;
  tvdb_id: string | null;
  scene_season: number | null;
  scene_episode: number | null;
  scene_absolute: number | null;
  anidb_season: number | null;
  anidb_episode: number | null;
  anidb_absolute: number | null;
  target_season: number | null;
  target_episode: number | null;
  target_absolute: number | null;
  source: string;
  locked: number;
  conflict_json: string | null;
  scraped_at: string | null;
}

export interface MappingConfigRow {
  show_id: string;
  enabled: number;
  source: string;
  health: string;
  health_detail: string | null;
  last_synced: string | null;
  last_error: string | null;
}

/** Fields a sync job / manual import provides when upserting mapping rows. */
export type ThexemMappingInput = Partial<
  Pick<
    EpisodeMappingRow,
    | 'scene_season' | 'scene_episode' | 'scene_absolute'
    | 'anidb_season' | 'anidb_episode' | 'anidb_absolute'
    | 'target_season' | 'target_episode' | 'target_absolute'
  >
>;

type Health = 'none' | 'ok' | 'conflicts' | 'missing' | 'error';

/**
 * Read the effective mapping config for a show. A show with no override row
 * falls back to `enabled = (series_type == 'anime')` (Q4: default ON for
 * anime, OFF otherwise) so no backfill migration is needed.
 */
export function getMappingConfig(
  self: DatabaseManager,
  showId: string,
): MappingConfigRow {
  const defaultEnabled = getShowSeriesType(self, showId) === 'anime';
  const row = self.drizz
    .select()
    .from(schema.episodeMappingConfig)
    .where(eq(schema.episodeMappingConfig.show_id, showId))
    .get() as MappingConfigRow | undefined;

  if (!row) {
    return {
      show_id: showId,
      enabled: defaultEnabled ? 1 : 0,
      source: 'thexem',
      health: 'none',
      health_detail: null,
      last_synced: null,
      last_error: null,
    };
  }

  return row;
}

export function setMappingConfig(
  self: DatabaseManager,
  showId: string,
  cfg: Partial<{
    enabled: boolean | number;
    source: string;
    health: Health;
    health_detail: string | null;
    last_synced: string | null;
    last_error: string | null;
  }>,
): MappingConfigRow {
  const existing = getMappingConfig(self, showId);
  self.drizz
    .insert(schema.episodeMappingConfig)
    .values({
      show_id: showId,
      enabled: cfg.enabled !== undefined ? (cfg.enabled ? 1 : 0) : existing.enabled,
      source: cfg.source ?? existing.source,
      health: cfg.health ?? existing.health,
      health_detail: cfg.health_detail !== undefined ? cfg.health_detail : existing.health_detail,
      last_synced: cfg.last_synced ?? existing.last_synced,
      last_error: cfg.last_error !== undefined ? cfg.last_error : existing.last_error,
    })
    .onConflictDoUpdate({
      target: schema.episodeMappingConfig.show_id,
      set: {
        enabled: cfg.enabled !== undefined ? (cfg.enabled ? 1 : 0) : existing.enabled,
        source: cfg.source ?? existing.source,
        health: cfg.health ?? existing.health,
        health_detail: cfg.health_detail !== undefined ? cfg.health_detail : existing.health_detail,
        last_synced: cfg.last_synced ?? existing.last_synced,
        last_error: cfg.last_error !== undefined ? cfg.last_error : existing.last_error,
      },
    })
    .run();
  return getMappingConfig(self, showId);
}

export function isMappingEnabled(self: DatabaseManager, showId: string): boolean {
  return getMappingConfig(self, showId).enabled === 1;
}

export function listEpisodeMappings(
  self: DatabaseManager,
  showId: string,
): EpisodeMappingRow[] {
  return self.drizz
    .select()
    .from(schema.episodeMappings)
    .where(eq(schema.episodeMappings.show_id, showId))
    .orderBy(schema.episodeMappings.scene_season, schema.episodeMappings.scene_episode)
    .all() as EpisodeMappingRow[];
}

/**
 * Find a mapping row for a scene-season/episode. Tier-1 (thexem) rows match
 * on scene numbering; tier-2 fallback rows key off anidb numbering.
 */
export function findSceneMapping(
  self: DatabaseManager,
  showId: string,
  season: number,
  episode: number,
): EpisodeMappingRow | null {
  const rows = self.drizz
    .select()
    .from(schema.episodeMappings)
    .where(
      and(
        eq(schema.episodeMappings.show_id, showId),
        eq(schema.episodeMappings.scene_season, season),
        eq(schema.episodeMappings.scene_episode, episode),
      ),
    )
    .all() as EpisodeMappingRow[];
  // Prefer thexem rows, then manual fixes over lock-free rows.
  return (
    rows.find(r => r.locked === 1 && r.source === 'thexem') ??
    rows.find(r => r.source === 'thexem') ??
    rows.find(r => r.locked === 1) ??
    rows[0] ??
    null
  );
}

export function findAbsoluteMapping(
  self: DatabaseManager,
  showId: string,
  absolute: number,
): EpisodeMappingRow | null {
  const rows = self.drizz
    .select()
    .from(schema.episodeMappings)
    .where(
      and(
        eq(schema.episodeMappings.show_id, showId),
        eq(schema.episodeMappings.scene_absolute, absolute),
      ),
    )
    .all() as EpisodeMappingRow[];
  return (
    rows.find(r => r.locked === 1) ??
    rows.find(r => r.source === 'thexem') ??
    rows[0] ??
    null
  );
}

/**
 * Replace the tier-1 rows for a show. Locked rows are preserved, unlocked
 * rows are deleted then re-inserted so stale scene numbering never lingers.
 */
export function replaceThexemMappings(
  self: DatabaseManager,
  showId: string,
  tvdbId: string,
  rows: ThexemMappingInput[],
): number {
  self.drizz
    .delete(schema.episodeMappings)
    .where(
      and(
        eq(schema.episodeMappings.show_id, showId),
        eq(schema.episodeMappings.source, 'thexem'),
        eq(schema.episodeMappings.locked, 0),
      ),
    )
    .run();

  // A user-locked row (manual fix) owns its scene key — never re-add a
  // refresh over it. The resolver prefers locked rows, so the manual target
  // keeps winning until the user unlocks it.
  const lockedKeys = new Set<string>();
  const locked = self.drizz
    .select()
    .from(schema.episodeMappings)
    .where(and(eq(schema.episodeMappings.show_id, showId), eq(schema.episodeMappings.locked, 1)))
    .all() as EpisodeMappingRow[];
  for (const r of locked) {
    if (r.scene_season != null && r.scene_episode != null) lockedKeys.add(`${r.scene_season}:${r.scene_episode}`);
  }

  const now = sql`(datetime('now'))`;
  let inserted = 0;
  for (const row of rows) {
    if (row.scene_season != null && row.scene_episode != null && lockedKeys.has(`${row.scene_season}:${row.scene_episode}`)) {
      continue;
    }
    self.drizz
      .insert(schema.episodeMappings)
      .values({
        show_id: showId,
        tvdb_id: tvdbId,
        scene_season: row.scene_season ?? null,
        scene_episode: row.scene_episode ?? null,
        scene_absolute: row.scene_absolute ?? null,
        anidb_season: row.anidb_season ?? null,
        anidb_episode: row.anidb_episode ?? null,
        anidb_absolute: row.anidb_absolute ?? null,
        target_season: row.target_season ?? null,
        target_episode: row.target_episode ?? null,
        target_absolute: row.target_absolute ?? null,
        source: 'thexem',
        locked: 0,
        conflict_json: null,
        scraped_at: now,
      })
      .run();
    inserted++;
  }
  return inserted;
}

/** User-confirmed manual fix: overwrite target + flag the row as locked. */
export function lockMappingRow(
  self: DatabaseManager,
  showId: string,
  rowId: number,
  target: { target_season: number; target_episode: number; target_absolute?: number },
): boolean {
  const updated = self.drizz
    .update(schema.episodeMappings)
    .set({
      target_season: target.target_season,
      target_episode: target.target_episode,
      target_absolute: target.target_absolute ?? null,
      source: 'manual',
      locked: 1,
    })
    .where(
      and(
        eq(schema.episodeMappings.id, rowId),
        eq(schema.episodeMappings.show_id, showId),
      ),
    )
    .run() as unknown as { changes: number };
  return updated.changes > 0;
}

export function deleteMappingsForShow(self: DatabaseManager, showId: string): void {
  self.drizz.delete(schema.episodeMappings).where(eq(schema.episodeMappings.show_id, showId)).run();
}

export function deleteMappingConfigForShow(self: DatabaseManager, showId: string): void {
  self.drizz.delete(schema.episodeMappingConfig).where(eq(schema.episodeMappingConfig.show_id, showId)).run();
}

function getShowSeriesType(self: DatabaseManager, showId: string): string {
  const row = self.drizz
    .select({ series_type: schema.shows.series_type })
    .from(schema.shows)
    .where(eq(schema.shows.id, showId))
    .get() as { series_type: string | null } | undefined;
  return row?.series_type ?? 'standard';
}