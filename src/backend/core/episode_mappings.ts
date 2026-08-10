import { db, type DatabaseManager } from '../db';
import { thexemClient, type XemBlock, type XemEntry, type TheXemClient } from '../providers/thexem/client';
import type { EpisodeMappingRow } from '../db/mappings';

export interface AppliedMapping {
  season: number;
  episode: number;
  absolute?: number | null;
  source: string;
}

type HealthStatus = 'none' | 'ok' | 'conflicts' | 'missing' | 'error';

interface HealthResult {
  health: HealthStatus;
  detail: string[];
}

/** Distinct season numbers across rows, excluding nulls. */
function distinctSeasons(rows: EpisodeMappingRow[], key: 'scene' | 'anidb' | 'target'): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    const v = key === 'scene' ? r.scene_season : key === 'anidb' ? r.anidb_season : r.target_season;
    if (v != null) set.add(v);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Cross-source disagreement detection (issues-tracking.md #4, F2/F4). The
 * badge turns red on ANY structural disagreement: scene/anime season-splits
 * against a consolidated provider listing, or AniDB vs provider season
 * counts. Each finding is stored in the config's health_detail for the
 * per-show drill-down.
 */
export function computeMappingHealth(rows: EpisodeMappingRow[]): HealthResult {
  if (rows.length === 0) return { health: 'missing', detail: ['No episode mappings have been fetched for this show.'] };

  const detail: string[] = [];

  const sceneSeasons = distinctSeasons(rows, 'scene');
  const anidbSeasons = distinctSeasons(rows, 'anidb');
  const targetSeasons = distinctSeasons(rows, 'target');

  if (targetSeasons.length === 1 && sceneSeasons.length > 1) {
    detail.push(
      `Scene/anime releases split this show into ${sceneSeasons.length} seasons (e.g. S${sceneSeasons[1]}E01) but the provider lists all ${rows.length} episodes as one S${targetSeasons[0]} season. Episode mapping translates scene numbering to the provider's.`,
    );
  }

  if (anidbSeasons.length > 0 && anidbSeasons.length !== targetSeasons.length) {
    detail.push(
      `AniDB splits this show into ${anidbSeasons.length} seasons (${anidbSeasons.join(', ')}) while the provider lists ${targetSeasons.length} (${targetSeasons.join(', ') || 'none'}).`,
    );
  }

  if (targetSeasons.length > 1 && sceneSeasons.length > 1 && targetSeasons.length !== sceneSeasons.length) {
    detail.push(
      `Season-count mismatch between scene numbering (${sceneSeasons.join(', ')}) and provider numbering (${targetSeasons.join(', ')}).`,
    );
  }

  let numberingMismatch = 0;
  for (const r of rows) {
    if (r.scene_absolute != null && r.target_absolute != null && r.scene_absolute !== r.target_absolute) {
      numberingMismatch++;
    }
  }
  if (numberingMismatch > 0) {
    detail.push(
      `${numberingMismatch} episode${numberingMismatch === 1 ? '' : 's'} carry a different absolute number in scene numbering than in the provider's (` +
        (rows.find(r => r.scene_absolute != null && r.target_absolute != null && r.scene_absolute !== r.target_absolute)
          ? `e.g. scene #${rows.find(r => r.scene_absolute != null && r.target_absolute != null && r.scene_absolute !== r.target_absolute)!.scene_absolute} -> provider #${rows.find(r => r.scene_absolute != null && r.target_absolute != null && r.scene_absolute !== r.target_absolute)!.target_absolute})`
          : '') +
        '.',
    );
  }

  return {
    health: detail.length > 0 ? 'conflicts' : 'ok',
    detail,
  };
}

function block(entry: XemEntry, key: string): XemBlock | undefined {
  const b = entry[key];
  if (b && typeof b === 'object' && Number.isFinite(b.season) && Number.isFinite(b.episode)) return b;
  return undefined;
}

export class EpisodeMappingService {
  constructor(
    private manager: DatabaseManager = db,
    private client: TheXemClient = thexemClient,
  ) {}

  isEnabled(showId: string): boolean {
    return this.manager.isEpisodeMappingEnabled(showId);
  }

  /** Resolve a scene-season/episode (what release files actually say) to the provider-native S/E via the mapping table. */
  resolveScene(showId: string, season: number, episode: number): AppliedMapping | null {
    const row = this.manager.findSceneMapping(showId, season, episode);
    if (!row || row.target_season == null || row.target_episode == null) return null;
    return {
      season: row.target_season,
      episode: row.target_episode,
      absolute: row.target_absolute ?? null,
      source: row.source,
    };
  }

  /** Resolve an absolute-numbered release to the provider-native S/E (more robust than the provider's own absolute lookup for split shows). */
  resolveAbsolute(showId: string, absolute: number): AppliedMapping | null {
    const row = this.manager.findAbsoluteMapping(showId, absolute);
    if (!row || row.target_season == null || row.target_episode == null) return null;
    return {
      season: row.target_season,
      episode: row.target_episode,
      absolute: row.target_absolute ?? null,
      source: row.source,
    };
  }

  /**
   * Fetch + persist the full TheXem mapping for a show (tier 1) and refresh
   * its health badge. Returns the updated mapping summary.
   */
  async syncShow(showId: string, opts: { refreshTTL?: boolean } = {}): Promise<ReturnType<typeof summarizeSync>> {
    const providers = this.manager.listShowProviders(showId) as { provider_type: string; provider_id: string }[];
    const tvdb = providers.find(p => p.provider_type === 'tvdb');

    if (!tvdb) {
      this.manager.setEpisodeMappingConfig(showId, {
        source: 'thexem',
        health: 'error',
        health_detail: JSON.stringify(['TheXem is keyed by TVDB id but this show has no TVDB provider; nothing to map.']),
        last_error: 'No TVDB provider id for this show.',
        last_synced: new Date().toISOString(),
      });
      return summarizeSync(this.manager, showId);
    }

    try {
      // Per-request fetch honors TheXem's own cache headers (7-day TTL by
      // default) via db.getCache; `refreshTTL` forces a refetch.
      if (opts.refreshTTL) this.manager.removeCacheKey(`thexem:all:${tvdb.provider_id}`);

      const entries = await this.client.getMappingAll(tvdb.provider_id);

      if (!entries || entries.length === 0) {
        // TheXem doesn't have this show. Tier 2 (AniDB/AniList fallback) is a
        // follow-up; for now surface a 'missing' badge so the user can fix
        // manually via the per-file override (issue #3) or the mapping row editor.
        this.manager.setEpisodeMappingConfig(showId, {
          source: 'thexem',
          health: 'missing',
          health_detail: JSON.stringify([`TheXem has no episode map for TVDB id ${tvdb.provider_id}. No automated mapping is available; use the manual season/episode override when importing.`]),
          last_error: 'TheXem has no mapping for this TVDB id',
          last_synced: new Date().toISOString(),
        });
        return summarizeSync(this.manager, showId);
      }

      const rows = entries
        .map(entry => {
          const scene = block(entry, 'scene');
          const anidb = block(entry, 'anidb');
          const target = block(entry, 'tvdb');
          return {
            scene_season: scene?.season ?? null,
            scene_episode: scene?.episode ?? null,
            scene_absolute: scene?.absolute ?? null,
            anidb_season: anidb?.season ?? null,
            anidb_episode: anidb?.episode ?? null,
            anidb_absolute: anidb?.absolute ?? null,
            target_season: target?.season ?? null,
            target_episode: target?.episode ?? null,
            target_absolute: target?.absolute ?? null,
          };
        })
        .filter(row => row.target_season != null || row.target_episode != null || row.scene_season != null);

      this.manager.replaceThexemMappings(showId, tvdb.provider_id, rows);
      const stored = this.manager.listEpisodeMappings(showId);
      const health = computeMappingHealth(stored);

      this.manager.setEpisodeMappingConfig(showId, {
        source: 'thexem',
        health: health.health,
        health_detail: JSON.stringify(health.detail),
        last_error: null,
        last_synced: new Date().toISOString(),
      });

      this.manager.logEvent({
        type: 'mapping',
        entityType: 'show',
        entityId: showId,
        message: `Episode mapping synced (${rows.length} episodes) via TheXem; health: ${health.health}`,
        metadata: { source: 'thexem', tvdbId: tvdb.provider_id, count: rows.length, health: health.health },
      });

      return summarizeSync(this.manager, showId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.manager.setEpisodeMappingConfig(showId, {
        source: 'thexem',
        health: 'error',
        health_detail: JSON.stringify([`Mapping sync failed: ${message}`]),
        last_error: message,
        last_synced: new Date().toISOString(),
      });
      this.manager.logEvent({ type: 'error', entityType: 'show', entityId: showId, message: `Episode mapping sync failed for ${showId}: ${message}` });
      throw err;
    }
  }
}

export function summarizeSync(manager: DatabaseManager, showId: string) {
  const config = manager.getEpisodeMappingConfig(showId);
  const rows = manager.listEpisodeMappings(showId);
  return {
    config: {
      showId: config.show_id,
      enabled: config.enabled === 1,
      source: config.source,
      health: config.health,
      healthDetail: config.health_detail ? safeParseDetail(config.health_detail) : [],
      lastSynced: config.last_synced,
      lastError: config.last_error,
    },
    mappedCount: rows.length,
    rows,
  };
}

function safeParseDetail(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return [json];
  }
  return [];
}

export async function syncMappingsForAnimeShows(): Promise<{ synced: number; failed: number }> {
  const shows = db.listShows() as { id: string; series_type: string }[];
  let synced = 0;
  let failed = 0;
  for (const show of shows) {
    const config = db.getEpisodeMappingConfig(show.id);
    if (config.enabled !== 1) continue;
    const age = config.last_synced ? Date.now() - new Date(config.last_synced).getTime() : Infinity;
    if (age < 7 * 24 * 60 * 60 * 1000) continue;
    try {
      await new EpisodeMappingService().syncShow(show.id);
      synced++;
    } catch {
      failed++;
    }
  }
  return { synced, failed };
}