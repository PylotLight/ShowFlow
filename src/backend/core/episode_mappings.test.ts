import { test, expect } from 'bun:test';
import { DatabaseManager } from '../db/index';
import {
  replaceThexemMappings,
  findSceneMapping,
  lockMappingRow,
  getMappingConfig,
} from '../db/mappings';
import { EpisodeMappingService, computeMappingHealth } from './episode_mappings';
import type { EpisodeMappingRow } from '../db/mappings';

let providerSeed = 0;
function seedShow(mgr: DatabaseManager, overrides: { seriesType?: string; title?: string; providerId?: string } = {}): string {
  const uuid = crypto.randomUUID();
  mgr.saveShow({
    uuid,
    providerId: overrides.providerId ?? String(366263 + providerSeed++),
    type: 'tvdb',
    title: overrides.title ?? 'Honzuki no Gekokujou',
    seriesType: overrides.seriesType ?? 'anime',
    config: {},
  });
  return uuid;
}

test('mapping config defaults ON for anime shows, OFF for standard, with no rows written', () => {
  const mgr = new DatabaseManager(':memory:');
  const animeId = seedShow(mgr, { seriesType: 'anime' });
  const standardId = seedShow(mgr, { seriesType: 'standard' });

  expect(getMappingConfig(mgr, animeId).enabled).toBe(1);
  expect(getMappingConfig(mgr, standardId).enabled).toBe(0);

  // No config row should exist until explicitly toggled.
  expect(mgr.listEpisodeMappings(animeId)).toHaveLength(0);
  mgr.close();
});

test('replaceThexemMappings stores scene->target rows and resolves via service', () => {
  const mgr = new DatabaseManager(':memory:');
  const showId = seedShow(mgr, { providerId: '366263' });

  replaceThexemMappings(mgr, showId, '366263', [
    { scene_season: 4, scene_episode: 17, scene_absolute: 53, anidb_season: 4, anidb_episode: 17, anidb_absolute: 17, target_season: 1, target_episode: 53, target_absolute: 53 },
    { scene_season: 4, scene_episode: 18, scene_absolute: 54, anidb_season: 4, anidb_episode: 18, anidb_absolute: 18, target_season: 1, target_episode: 54, target_absolute: 54 },
  ]);

  const row = findSceneMapping(mgr, showId, 4, 17);
  expect(row).not.toBeNull();
  expect(row!.target_season).toBe(1);
  expect(row!.target_episode).toBe(53);

  const svc = new EpisodeMappingService(mgr, { getMappingAll: async () => [] } as never);
  expect(svc.isEnabled(showId)).toBe(true);
  expect(svc.resolveScene(showId, 4, 17)).toEqual({ season: 1, episode: 53, absolute: 53, source: 'thexem' });
  expect(svc.resolveScene(showId, 4, 99)).toBeNull();
  expect(svc.resolveAbsolute(showId, 54)).toEqual({ season: 1, episode: 54, absolute: 54, source: 'thexem' });

  mgr.close();
});

test('user-locked rows survive the next thexem sync; unlocked rows are replaced', async () => {
  const mgr = new DatabaseManager(':memory:');
  const showId = seedShow(mgr);

  replaceThexemMappings(mgr, showId, '366263', [
    { scene_season: 4, scene_episode: 17, scene_absolute: 53, target_season: 1, target_episode: 53 },
    { scene_season: 4, scene_episode: 18, scene_absolute: 54, target_season: 1, target_episode: 54 },
  ]);
  const rows = mgr.listEpisodeMappings(showId);
  rows.sort((a, b) => (a.scene_episode ?? 0) - (b.scene_episode ?? 0));
  lockMappingRow(mgr, showId, rows[0]!.id, { target_season: 1, target_episode: 999, target_absolute: 53 });

  const fakeClient = {
    getMappingAll: async () =>
      [
        { scene: { season: 4, episode: 17, absolute: 53 }, anidb: { season: 4, episode: 17, absolute: 17 }, tvdb: { season: 1, episode: 530, absolute: 53 } },
        { scene: { season: 4, episode: 18, absolute: 54 }, anidb: { season: 4, episode: 18, absolute: 18 }, tvdb: { season: 1, episode: 540, absolute: 54 } },
      ] as never,
  };

  const svc = new EpisodeMappingService(mgr, fakeClient as never);
  const summary = await svc.syncShow(showId);

  // Locked row keeps the user's target (1/999), the ep-18 unlocked row refreshes to the new value (540).
  const afterRows = mgr.listEpisodeMappings(showId);
  const locked = afterRows.find(r => r.locked === 1);
  const refreshedEp18 = afterRows.find(r => r.locked === 0 && r.scene_episode === 18);
  expect(locked!.target_episode).toBe(999);
  expect(refreshedEp18!.target_episode).toBe(540);
  // Locked rows own their scene key, so no duplicate was re-added.
  expect(afterRows).toHaveLength(2);

  mgr.close();
});

test('syncShow marks the show missing when TheXem has no mapping', async () => {
  const mgr = new DatabaseManager(':memory:');
  const showId = seedShow(mgr);
  const svc = new EpisodeMappingService(mgr, { getMappingAll: async () => null } as never);

  const summary = await svc.syncShow(showId);
  expect(summary.mappedCount).toBe(0);
  expect(summary.config.health).toBe('missing');
  expect(summary.config.lastError).toContain('no mapping');

  mgr.close();
});

test('syncShow errors cleanly when the show has no TVDB provider', async () => {
  const mgr = new DatabaseManager(':memory:');
  const uuid = crypto.randomUUID();
  mgr.saveShow({ uuid, providerId: '123', type: 'anilist', title: 'Anime Only', seriesType: 'anime', config: {} });
  const svc = new EpisodeMappingService(mgr, { getMappingAll: async () => [] } as never);

  const summary = await svc.syncShow(uuid);
  expect(summary.config.health).toBe('error');

  mgr.close();
});

test('computeMappingHealth flags the Honzuki season-split as a conflict', () => {
  const row = (sceneSeason: number, sceneEp: number, targetEp: number): EpisodeMappingRow => ({
    id: sceneEp, show_id: 's', tvdb_id: '366263', source: 'thexem', locked: 0,
    anidb_season: sceneSeason, anidb_episode: sceneEp, anidb_absolute: targetEp,
    scene_season: sceneSeason, scene_episode: sceneEp, scene_absolute: targetEp,
    target_season: 1, target_episode: targetEp, target_absolute: targetEp,
    conflict_json: null, scraped_at: null,
  });

  // Flat provider season with multi-season scene/AniDB structure -> conflict
  // (4 scene/AniDB seasons all resolve onto TVDB's single S01).
  const honzuki = Array.from({ length: 4 }, (_, i) => row(i + 1, 1, i + 1));
  const conflict = computeMappingHealth(honzuki);
  expect(conflict.health).toBe('conflicts');
  expect(conflict.detail.some(d => d.includes('seasons'))).toBe(true);

  // Normal 1:1 show -> ok.
  const flat: EpisodeMappingRow = {
    ...row(1, 1, 1),
    anidb_season: 1, anidb_episode: 1, anidb_absolute: 1,
    scene_season: 1, scene_episode: 1, scene_absolute: 1,
  };
  expect(computeMappingHealth([flat]).health).toBe('ok');

  expect(computeMappingHealth([]).health).toBe('missing');
});