import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, and, like, sql, asc } from 'drizzle-orm';
import * as schema from './schema';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

export const ConfigSchema = z.object({
  libraryPath: z.string().nullish(),
  apiKeys: z.record(z.string(), z.string()).optional(),
  defaultProvider: z.enum(['tmdb', 'tvdb', 'anilist']),
  onCollision: z.enum(['overwrite', 'skip', 'version']).default('skip'),
  dryRun: z.boolean().default(false),
  downloadClient: z.object({
    type: z.enum(['blackhole', 'none']).default('blackhole'),
    blackhole: z.object({
      watchFolder: z.string().optional(),
    }).optional(),
  }).default({ type: 'blackhole' }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const ProwlarrConfigSchema = z.object({
  baseUrl: z.string().url({ message: "Prowlarr URL must be a valid URL (e.g. http://localhost:9696)" }),
  apiKey: z.string().min(1, { message: "API Key is required" }),
  syncLevel: z.enum(['full', 'addRemoveOnly', 'disabled']).default('full'),
  tags: z.array(z.number()).default([]),
});

export type ProwlarrConfig = z.infer<typeof ProwlarrConfigSchema>;

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class DatabaseManager {
  public db: Database;
  public drizz: ReturnType<typeof drizzle>;

  constructor(dbPath = 'showflow.db') {
    this.db = new Database(dbPath);
    this.db.run('PRAGMA foreign_keys = ON');
    this.drizz = drizzle(this.db, { schema });
    this.init();
  }

  private init() {
    // ---- New schema tables (managed by Drizzle) ---------------------------

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        original_title TEXT,
        year INTEGER,
        profile TEXT DEFAULT 'standard',
        config_json TEXT,
        root_folder_path TEXT,
        sort_title TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        last_updated TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS show_providers (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        provider_type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        title TEXT,
        original_title TEXT,
        year INTEGER,
        metadata_json TEXT,
        is_primary INTEGER DEFAULT 0,
        last_synced TEXT,
        PRIMARY KEY (show_id, provider_type)
      )
    `);

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_show_providers_provider
      ON show_providers(provider_type, provider_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS seasons (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL,
        title TEXT,
        last_updated TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (show_id, season_number)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS episodes (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        absolute_number INTEGER,
        title TEXT,
        file_path TEXT,
        is_tracked INTEGER DEFAULT 0,
        air_date TEXT,
        search_mode TEXT DEFAULT 'auto',
        last_updated TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (show_id, season_number, episode_number)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS show_artworks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        provider_type TEXT NOT NULL,
        artwork_type TEXT NOT NULL,
        image_url TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        thumbnail TEXT,
        content_type TEXT,
        data BLOB,
        UNIQUE(show_id, provider_type, artwork_type)
      )
    `);

    // ---- Legacy tables (raw SQL) ------------------------------------------

    this.db.run(`
      CREATE TABLE IF NOT EXISTS processed_files (
        file_hash TEXT PRIMARY KEY,
        original_path TEXT,
        final_path TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata_cache (
        cache_key TEXT PRIMARY KEY,
        raw_json TEXT,
        expires_at DATETIME
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        name TEXT PRIMARY KEY,
        interval_minutes INTEGER,
        last_execution DATETIME,
        last_duration_ms INTEGER,
        next_execution DATETIME,
        enabled BOOLEAN DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS quality_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        rank INTEGER DEFAULT 0,
        min_size INTEGER,
        max_size INTEGER
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS quality_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cutoff_quality_id TEXT,
        FOREIGN KEY (cutoff_quality_id) REFERENCES quality_definitions(id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS custom_formats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        regex TEXT NOT NULL,
        score INTEGER DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS profile_formats (
        profile_id TEXT,
        format_id TEXT,
        type TEXT DEFAULT 'bonus',
        PRIMARY KEY (profile_id, format_id),
        FOREIGN KEY (profile_id) REFERENCES quality_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (format_id) REFERENCES custom_formats(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS root_folders (
        path TEXT PRIMARY KEY
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        event_type TEXT,
        entity_type TEXT,
        entity_id TEXT,
        message TEXT,
        metadata_json TEXT
      )
    `);
  }

  // ---- Shows -------------------------------------------------------------

  saveShow(show: { uuid: string, providerId: string, type: string, title: string, profile?: string, config: any, year?: number, originalTitle?: string, metadata?: any, rootFolderPath?: string }) {
    const configJson = typeof show.config === 'string' ? show.config : JSON.stringify(show.config);

    this.drizz.insert(schema.shows).values({
      id: show.uuid,
      title: show.title,
      original_title: show.originalTitle ?? null,
      year: show.year ?? null,
      profile: show.profile || 'standard',
      config_json: configJson,
      root_folder_path: show.rootFolderPath ?? null,
    }).onConflictDoUpdate({
      target: schema.shows.id,
      set: {
        title: show.title,
        original_title: show.originalTitle ?? null,
        year: show.year ?? null,
        profile: show.profile || 'standard',
        config_json: configJson,
        root_folder_path: show.rootFolderPath ?? null,
        last_updated: sql`(datetime('now'))`,
      },
    }).run();

    const existingProvider = this.drizz.select({ pt: schema.showProviders.provider_type })
      .from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, show.uuid),
        eq(schema.showProviders.provider_type, show.type),
      )).get();

    if (existingProvider) {
      this.drizz.update(schema.showProviders).set({
        provider_id: show.providerId,
        title: show.title,
        original_title: show.originalTitle ?? null,
        year: show.year ?? null,
        metadata_json: show.metadata ? JSON.stringify(show.metadata) : null,
        last_synced: sql`(datetime('now'))`,
      }).where(and(
        eq(schema.showProviders.show_id, show.uuid),
        eq(schema.showProviders.provider_type, show.type),
      )).run();
    } else {
      const providerCount = this.drizz.select({ c: sql<number>`count(*)` })
        .from(schema.showProviders)
        .where(eq(schema.showProviders.show_id, show.uuid))
        .get();

      this.drizz.insert(schema.showProviders).values({
        show_id: show.uuid,
        provider_type: show.type,
        provider_id: show.providerId,
        title: show.title,
        original_title: show.originalTitle ?? null,
        year: show.year ?? null,
        metadata_json: show.metadata ? JSON.stringify(show.metadata) : null,
        is_primary: (providerCount?.c ?? 0) === 0 ? 1 : 0,
      }).run();
    }
  }

  updateShowSyncData(showId: string, providerType: string, data: { title?: string, year?: number, originalTitle?: string, metadata?: any }) {
    const showSet: Record<string, any> = { last_updated: sql`(datetime('now'))` };
    if (data.title !== undefined) showSet.title = data.title;
    if (data.year !== undefined) showSet.year = data.year;
    if (data.originalTitle !== undefined) showSet.original_title = data.originalTitle;

    this.drizz.update(schema.shows).set(showSet)
      .where(eq(schema.shows.id, showId)).run();

    const providerSet: Record<string, any> = { last_synced: sql`(datetime('now'))` };
    if (data.title !== undefined) providerSet.title = data.title;
    if (data.year !== undefined) providerSet.year = data.year;
    if (data.originalTitle !== undefined) providerSet.original_title = data.originalTitle;
    if (data.metadata !== undefined) providerSet.metadata_json = JSON.stringify(data.metadata);

    this.drizz.update(schema.showProviders).set(providerSet)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).run();
  }

  getShow(showId: string) {
    const row = this.drizz.select().from(schema.shows)
      .where(eq(schema.shows.id, showId)).get();

    if (!row) return null as any;

    const primaryProvider = this.drizz.select().from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.is_primary, 1),
      )).get();

    return {
      ...row,
      provider_id: primaryProvider?.provider_id || row.id,
      provider_type: primaryProvider?.provider_type || null,
      provider_metadata: primaryProvider?.metadata_json || null,
      uuid: row.id,
    } as any;
  }

  getShowConfig(showId: string): Record<string, any> {
    const row = this.drizz.select({ config_json: schema.shows.config_json })
      .from(schema.shows)
      .where(eq(schema.shows.id, showId)).get();
    if (!row?.config_json) return {};
    try {
      return JSON.parse(row.config_json);
    } catch {
      return {};
    }
  }

  getProviderForRole(showId: string, role: 'metadata' | 'airtime'): { providerType: string; providerId: string } | null {
    const config = this.getShowConfig(showId);
    const roleKey = role === 'metadata' ? 'metadataProvider' : 'airtimeProvider';
    const providerType = config[roleKey] as string | undefined;

    if (providerType) {
      const provider = this.drizz.select().from(schema.showProviders)
        .where(and(
          eq(schema.showProviders.show_id, showId),
          eq(schema.showProviders.provider_type, providerType),
        )).get();
      if (provider) {
        return { providerType: provider.provider_type, providerId: provider.provider_id };
      }
    }

    // Fall back to primary provider
    const primary = this.drizz.select().from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.is_primary, 1),
      )).get();
    if (primary) {
      return { providerType: primary.provider_type, providerId: primary.provider_id };
    }

    return null;
  }

  setProviderRole(showId: string, providerType: string, role: 'metadata' | 'airtime', active: boolean): void {
    const config = this.getShowConfig(showId);
    const roleKey = role === 'metadata' ? 'metadataProvider' : 'airtimeProvider';

    if (active) {
      config[roleKey] = providerType;
    } else {
      // If clearing the current role holder, unset it
      if (config[roleKey] === providerType) {
        delete config[roleKey];
      }
    }

    this.drizz.update(schema.shows).set({
      config_json: JSON.stringify(config),
    }).where(eq(schema.shows.id, showId)).run();
  }

  listShowProvidersWithRoles(showId: string): any[] {
    const providers = this.drizz.select().from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, showId))
      .all() as any[];
    const config = this.getShowConfig(showId);

    return providers.map(p => ({
      ...p,
      roles: {
        metadata: config.metadataProvider === p.provider_type || (!config.metadataProvider && !!p.is_primary),
        airtime: config.airtimeProvider === p.provider_type || (!config.airtimeProvider && !!p.is_primary),
      },
    }));
  }

  getShowByName(name: string) {
    const rows = this.drizz.select().from(schema.shows)
      .where(like(schema.shows.title, `%${name}%`))
      .all();

    return rows.map(row => {
      const primaryProvider = this.drizz.select().from(schema.showProviders)
        .where(and(
          eq(schema.showProviders.show_id, row.id),
          eq(schema.showProviders.is_primary, 1),
        )).get();

      return {
        ...row,
        provider_id: primaryProvider?.provider_id || row.id,
        provider_type: primaryProvider?.provider_type || null,
        provider_metadata: primaryProvider?.metadata_json || null,
        uuid: row.id,
      } as any;
    });
  }

  listShows() {
    const rows = this.drizz.select().from(schema.shows).all();

    const showIds = rows.map(r => r.id);
    const providers = showIds.length > 0
      ? this.drizz.select().from(schema.showProviders)
          .where(and(
            sql`${schema.showProviders.show_id} IN ${showIds}`,
            eq(schema.showProviders.is_primary, 1),
          )).all()
      : [];

    const providerMap = new Map(providers.map(p => [p.show_id, p]));

    return rows.map(row => {
      const primaryProvider = providerMap.get(row.id);
      return {
        ...row,
        provider_id: primaryProvider?.provider_id || row.id,
        provider_type: primaryProvider?.provider_type || null,
        provider_metadata: primaryProvider?.metadata_json || null,
        uuid: row.id,
      } as any;
    });
  }

  hasUpcomingEpisodes(showId: string) {
    const row = this.drizz.select({ one: sql<number>`1` })
      .from(schema.episodes)
      .where(and(
        eq(schema.episodes.show_id, showId),
        sql`air_date > datetime('now')`,
      ))
      .limit(1)
      .get();
    return !!row;
  }

  getShowByProvider(providerType: string, providerId: string) {
    const providerRow = this.drizz.select().from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.provider_type, providerType),
        eq(schema.showProviders.provider_id, providerId),
      )).get();

    if (!providerRow) return null as any;

    const show = this.drizz.select().from(schema.shows)
      .where(eq(schema.shows.id, providerRow.show_id)).get();

    if (!show) return null as any;

    return {
      ...show,
      provider_type: providerRow.provider_type,
      provider_id: providerRow.provider_id,
      provider_metadata: providerRow.metadata_json,
      uuid: show.id,
    } as any;
  }

  addShowProvider(showId: string, providerType: string, providerId: string, data?: { title?: string, originalTitle?: string, year?: number, metadata?: any, isPrimary?: boolean }): void {
    const existing = this.drizz.select({ pt: schema.showProviders.provider_type })
      .from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).get();

    if (existing) {
      const setData: Record<string, any> = {
        last_synced: sql`(datetime('now'))`,
      };
      setData.provider_id = providerId;
      if (data?.title !== undefined) setData.title = data.title;
      if (data?.originalTitle !== undefined) setData.original_title = data.originalTitle;
      if (data?.year !== undefined) setData.year = data.year;
      if (data?.metadata !== undefined) setData.metadata_json = JSON.stringify(data.metadata);
      if (data?.isPrimary !== undefined) setData.is_primary = data.isPrimary ? 1 : 0;

      this.drizz.update(schema.showProviders).set(setData)
        .where(and(
          eq(schema.showProviders.show_id, showId),
          eq(schema.showProviders.provider_type, providerType),
        )).run();
    } else {
      const providerCount = this.drizz.select({ c: sql<number>`count(*)` })
        .from(schema.showProviders)
        .where(eq(schema.showProviders.show_id, showId))
        .get();

      const values: Record<string, any> = {
        show_id: showId,
        provider_type: providerType,
        provider_id: providerId,
        is_primary: data?.isPrimary !== undefined ? (data.isPrimary ? 1 : 0) : ((providerCount?.c ?? 0) === 0 ? 1 : 0),
      };
      if (data?.title !== undefined) values.title = data.title;
      if (data?.originalTitle !== undefined) values.original_title = data.originalTitle;
      if (data?.year !== undefined) values.year = data.year;
      if (data?.metadata !== undefined) values.metadata_json = JSON.stringify(data.metadata);

      this.drizz.insert(schema.showProviders).values(values).run();
    }
  }

  removeShowProvider(showId: string, providerType: string): void {
    const count = this.drizz.select({ c: sql<number>`count(*)` })
      .from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, showId))
      .get();

    if (!count || count.c <= 1) {
      throw new Error('Cannot remove the last provider from a show');
    }

    this.drizz.delete(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).run();
  }

  setPrimaryProvider(showId: string, providerType: string): void {
    this.drizz.update(schema.showProviders).set({ is_primary: 0 })
      .where(eq(schema.showProviders.show_id, showId)).run();

    this.drizz.update(schema.showProviders).set({ is_primary: 1 })
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).run();
  }

  listShowProviders(showId: string): any[] {
    return this.drizz.select().from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, showId))
      .all() as any[];
  }

  // ---- Seasons -----------------------------------------------------------

  saveSeason(showId: string, seasonNumber: number, title?: string) {
    this.drizz.insert(schema.seasons).values({
      show_id: showId,
      season_number: seasonNumber,
      title: title ?? '',
    }).onConflictDoUpdate({
      target: [schema.seasons.show_id, schema.seasons.season_number],
      set: {
        title: title ?? '',
        last_updated: sql`(datetime('now'))`,
      },
    }).run();
  }

  getSeason(showId: string, seasonNumber: number) {
    return this.drizz.select().from(schema.seasons)
      .where(and(
        eq(schema.seasons.show_id, showId),
        eq(schema.seasons.season_number, seasonNumber),
      )).get() as any;
  }

  listSeasons(showId: string) {
    return this.drizz.select().from(schema.seasons)
      .where(eq(schema.seasons.show_id, showId))
      .orderBy(asc(schema.seasons.season_number))
      .all() as any[];
  }

  // ---- Episodes ----------------------------------------------------------

  saveEpisode(episode: { showId: string, seasonNumber: number, episodeNumber: number, absoluteNumber?: number, title?: string, filePath?: string }) {
    this.drizz.insert(schema.episodes).values({
      show_id: episode.showId,
      season_number: episode.seasonNumber,
      episode_number: episode.episodeNumber,
      absolute_number: episode.absoluteNumber ?? 0,
      title: episode.title ?? '',
      file_path: episode.filePath ?? '',
    }).onConflictDoUpdate({
      target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
      set: {
        title: episode.title ?? '',
        absolute_number: episode.absoluteNumber ?? 0,
        file_path: episode.filePath ?? '',
        last_updated: sql`(datetime('now'))`,
      },
    }).run();
  }

  syncEpisodes(showId: string, episodes: { seasonNumber: number, episodeNumber: number, absoluteNumber?: number, title?: string, airDate?: string }[]) {
    const transaction = this.db.transaction((eps: typeof episodes) => {
      for (const ep of eps) {
        this.drizz.insert(schema.episodes).values({
          show_id: showId,
          season_number: ep.seasonNumber,
          episode_number: ep.episodeNumber,
          absolute_number: ep.absoluteNumber ?? 0,
          title: ep.title ?? '',
          air_date: ep.airDate ?? null,
        }).onConflictDoUpdate({
          target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
          set: {
            title: ep.title ?? '',
            absolute_number: ep.absoluteNumber ?? 0,
            air_date: ep.airDate ?? null,
            last_updated: sql`(datetime('now'))`,
          },
        }).run();
      }
    });
    transaction(episodes);
  }

  getEpisode(showId: string, seasonNumber: number, episodeNumber: number) {
    return this.drizz.select().from(schema.episodes)
      .where(and(
        eq(schema.episodes.show_id, showId),
        eq(schema.episodes.season_number, seasonNumber),
        eq(schema.episodes.episode_number, episodeNumber),
      )).get() as any;
  }

  listEpisodes(showId: string, seasonNumber: number) {
    return this.drizz.select().from(schema.episodes)
      .where(and(
        eq(schema.episodes.show_id, showId),
        eq(schema.episodes.season_number, seasonNumber),
      ))
      .orderBy(asc(schema.episodes.season_number), asc(schema.episodes.episode_number))
      .all() as any[];
  }

  listAllEpisodes(showId: string) {
    return this.drizz.select().from(schema.episodes)
      .where(eq(schema.episodes.show_id, showId))
      .orderBy(asc(schema.episodes.season_number), asc(schema.episodes.episode_number))
      .all() as any[];
  }

  listUpcomingEpisodes(futureDays: number, pastDays = 0) {
    const start = new Date(Date.now() - pastDays * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000).toISOString();

    const result = this.drizz.select({
      episode: schema.episodes,
      show_title: schema.shows.title,
    })
      .from(schema.episodes)
      .leftJoin(schema.shows, eq(schema.episodes.show_id, schema.shows.id))
      .where(and(
        sql`${schema.episodes.air_date} IS NOT NULL`,
        sql`${schema.episodes.air_date} >= ${start}`,
        sql`${schema.episodes.air_date} <= ${end}`,
      ))
      .orderBy(asc(schema.episodes.air_date))
      .all();

    return result.map(r => ({
      ...r.episode,
      show_title: r.show_title,
    })) as any[];
  }

  setTracked(showId: string, seasonNumber: number, episodeNumber: number, tracked: boolean) {
    this.drizz.update(schema.episodes).set({ is_tracked: tracked ? 1 : 0 })
      .where(and(
        eq(schema.episodes.show_id, showId),
        eq(schema.episodes.season_number, seasonNumber),
        eq(schema.episodes.episode_number, episodeNumber),
      )).run();
  }

  updateEpisodeFilePath(showId: string, seasonNumber: number, episodeNumber: number, filePath: string) {
    this.drizz.update(schema.episodes).set({ file_path: filePath })
      .where(and(
        eq(schema.episodes.show_id, showId),
        eq(schema.episodes.season_number, seasonNumber),
        eq(schema.episodes.episode_number, episodeNumber),
      )).run();
  }

  updateEpisodeSearchMode(showId: string, seasonNumber: number, episodeNumber: number, mode: string) {
    this.drizz.update(schema.episodes).set({ search_mode: mode })
      .where(and(
        eq(schema.episodes.show_id, showId),
        eq(schema.episodes.season_number, seasonNumber),
        eq(schema.episodes.episode_number, episodeNumber),
      )).run();
  }

  getShowRootFolder(showId: string): string | null {
    const row = this.drizz.select({ root_folder_path: schema.shows.root_folder_path })
      .from(schema.shows)
      .where(eq(schema.shows.id, showId))
      .get();
    return row?.root_folder_path || null;
  }

  updateShow(showId: string, updates: Partial<{ title: string, profile: string, config: any, rootFolderPath: string }>) {
    const setData: Record<string, any> = { last_updated: sql`(datetime('now'))` };
    if (updates.title !== undefined) setData.title = updates.title;
    if (updates.profile !== undefined) setData.profile = updates.profile;
    if (updates.config !== undefined) {
      // Merge config with existing config
      const existingConfig = this.getShowConfig(showId);
      const merged = { ...existingConfig, ...updates.config };
      setData.config_json = JSON.stringify(merged);
    }
    if (updates.rootFolderPath !== undefined) setData.root_folder_path = updates.rootFolderPath;

    this.drizz.update(schema.shows).set(setData)
      .where(eq(schema.shows.id, showId)).run();
  }

  removeShow(showId: string) {
    this.drizz.delete(schema.shows)
      .where(eq(schema.shows.id, showId)).run();
  }

  // ---- Show Artworks -----------------------------------------------------

  saveShowArtwork(showId: string, type: number, imageUrl: string, width?: number, height?: number, thumbnail?: string, data?: Uint8Array, contentType?: string, providerType?: string) {
    if (!providerType) {
      const primaryProvider = this.drizz.select({ pt: schema.showProviders.provider_type })
        .from(schema.showProviders)
        .where(and(
          eq(schema.showProviders.show_id, showId),
          eq(schema.showProviders.is_primary, 1),
        )).get();
      providerType = primaryProvider?.pt || 'unknown';
    }

    const artworkType = String(type);

    const existing = this.drizz.select({ id: schema.showArtworks.id })
      .from(schema.showArtworks)
      .where(and(
        eq(schema.showArtworks.show_id, showId),
        eq(schema.showArtworks.provider_type, providerType),
        eq(schema.showArtworks.artwork_type, artworkType),
      )).get();

    if (existing) {
      this.drizz.update(schema.showArtworks).set({
        image_url: imageUrl,
        width: width ?? null,
        height: height ?? null,
        thumbnail: thumbnail ?? null,
        content_type: contentType ?? null,
        data: data ?? null,
      }).where(eq(schema.showArtworks.id, existing.id)).run();
    } else {
      this.drizz.insert(schema.showArtworks).values({
        show_id: showId,
        provider_type: providerType,
        artwork_type: artworkType,
        image_url: imageUrl,
        width: width ?? null,
        height: height ?? null,
        thumbnail: thumbnail ?? null,
        content_type: contentType ?? null,
        data: data ?? null,
      }).run();
    }
  }

  getShowArtworks(showId: string, type?: number, providerType?: string) {
    const conditions = [eq(schema.showArtworks.show_id, showId)];
    if (type !== undefined) conditions.push(eq(schema.showArtworks.artwork_type, String(type)));
    if (providerType !== undefined) conditions.push(eq(schema.showArtworks.provider_type, providerType));

    return this.drizz.select().from(schema.showArtworks)
      .where(and(...conditions))
      .orderBy(asc(schema.showArtworks.artwork_type))
      .all() as any[];
  }

  updateShowArtworkData(showId: string, type: number, data: Uint8Array, providerType?: string) {
    const conditions = [
      eq(schema.showArtworks.show_id, showId),
      eq(schema.showArtworks.artwork_type, String(type)),
    ];
    if (providerType !== undefined) conditions.push(eq(schema.showArtworks.provider_type, providerType));

    this.drizz.update(schema.showArtworks).set({ data })
      .where(and(...conditions)).run();
  }

  // ---- Processed files (dedup) -------------------------------------------

  logProcessedFile(hash: string, original: string, final: string) {
    this.db.run(
      'INSERT OR REPLACE INTO processed_files (file_hash, original_path, final_path) VALUES (?, ?, ?)',
      [hash, original, final]
    );
  }

  isProcessed(hash: string): boolean {
    const row = this.db.query('SELECT file_hash FROM processed_files WHERE file_hash = ?').get(hash);
    return !!row;
  }

  // ---- Metadata cache ----------------------------------------------------

  getCache<T = any>(key: string): T | null {
    const row = this.db.query('SELECT raw_json, expires_at FROM metadata_cache WHERE cache_key = ?').get(key) as
      | { raw_json: string; expires_at: string }
      | undefined;

    if (!row) return null;

    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.run('DELETE FROM metadata_cache WHERE cache_key = ?', [key]);
      return null;
    }

    try {
      return JSON.parse(row.raw_json) as T;
    } catch {
      return null;
    }
  }

  setCache(key: string, data: any, ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.run(
      'INSERT OR REPLACE INTO metadata_cache (cache_key, raw_json, expires_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(data), expiresAt]
    );
  }

  // ---- Tasks -------------------------------------------------------------

  saveTask(task: { name: string, intervalMinutes: number, lastExecution?: string, lastDurationMs?: number, nextExecution?: string, enabled?: boolean }) {
    this.db.run(
      'INSERT OR REPLACE INTO scheduled_tasks (name, interval_minutes, last_execution, last_duration_ms, next_execution, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      [task.name, task.intervalMinutes, task.lastExecution ?? null, task.lastDurationMs ?? null, task.nextExecution ?? null, task.enabled ?? 1]
    );
  }

  listTasks() {
    return this.db.query('SELECT * FROM scheduled_tasks').all() as any[];
  }

  updateTaskExecution(name: string, durationMs: number, nextExecution: string) {
    this.db.run('UPDATE scheduled_tasks SET last_execution = CURRENT_TIMESTAMP, last_duration_ms = ?, next_execution = ? WHERE name = ?', [durationMs, nextExecution, name]);
  }

  logEvent(event: { type: string, entityType?: string, entityId?: string, message: string, metadata?: any }) {
    this.db.run(
      'INSERT INTO audit_logs (event_type, entity_type, entity_id, message, metadata_json) VALUES (?, ?, ?, ?, ?)',
      [event.type, event.entityType ?? null, event.entityId ?? null, event.message, event.metadata ? JSON.stringify(event.metadata) : null]
    );
  }

  listRecentEvents(limit = 20) {
    return this.db.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) as any[];
  }

  // ---- Root Folders ------------------------------------------------------

  listRootFolders(): { path: string }[] {
    return this.db.query('SELECT * FROM root_folders ORDER BY path ASC').all() as { path: string }[];
  }

  addRootFolder(path: string) {
    this.db.run('INSERT OR IGNORE INTO root_folders (path) VALUES (?)', [path]);
  }

  removeRootFolder(path: string) {
    this.db.run('DELETE FROM root_folders WHERE path = ?', [path]);
  }

  getUnmappedFolders(): { path: string; subfolders: string[] }[] {
    const roots = this.listRootFolders();
    const shows = this.listShows();
    return roots.map(root => {
      const entries: string[] = [];
      try {
        const dir = fs.readdirSync(root.path);
        for (const entry of dir) {
          const fullPath = path.join(root.path, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            entries.push(entry);
          }
        }
      } catch {}
      const mappedShowTitles = new Set(shows.map(s => s.title));
      const unmapped = entries.filter(e => !mappedShowTitles.has(e));
      return { path: root.path, subfolders: unmapped };
    });
  }

  // ---- Settings ----------------------------------------------------------

  getSetting(key: string) {
    const row = this.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: any) {
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, val]);
  }

  removeSetting(key: string) {
    this.db.run('DELETE FROM settings WHERE key = ?', [key]);
  }

  getAllSettings() {
    return this.db.query('SELECT * FROM settings').all() as { key: string; value: string }[];
  }

  // ---- Quality & Profiles ------------------------------------------------

  saveQuality(q: { id: string, name: string, rank: number, minSize?: number, maxSize?: number }) {
    this.db.run(
      'INSERT OR REPLACE INTO quality_definitions (id, name, rank, min_size, max_size) VALUES (?, ?, ?, ?, ?)',
      [q.id, q.name, q.rank, q.minSize ?? null, q.maxSize ?? null]
    );
  }

  getQuality(id: string) {
    return this.db.query('SELECT * FROM quality_definitions WHERE id = ?').get(id) as any;
  }

  listQualities() {
    return this.db.query('SELECT * FROM quality_definitions ORDER BY rank DESC').all() as any[];
  }

  saveProfile(p: { id: string, name: string, cutoffId?: string }) {
    this.db.run(
      'INSERT OR REPLACE INTO quality_profiles (id, name, cutoff_quality_id) VALUES (?, ?, ?)',
      [p.id, p.name, p.cutoffId ?? null]
    );
  }

  getProfile(id: string) {
    return this.db.query('SELECT * FROM quality_profiles WHERE id = ?').get(id) as any;
  }

  listProfiles() {
    return this.db.query('SELECT * FROM quality_profiles').all() as any[];
  }

  saveCustomFormat(f: { id: string, name: string, regex: string, score: number }) {
    this.db.run(
      'INSERT OR REPLACE INTO custom_formats (id, name, regex, score) VALUES (?, ?, ?, ?)',
      [f.id, f.name, f.regex, f.score]
    );
  }

  getCustomFormat(id: string) {
    return this.db.query('SELECT * FROM custom_formats WHERE id = ?').get(id) as any;
  }

  listCustomFormats() {
    return this.db.query('SELECT * FROM custom_formats').all() as any[];
  }

  addProfileFormat(profileId: string, formatId: string, type: 'bonus' | 'required' | 'forbidden' = 'bonus') {
    this.db.run('INSERT OR REPLACE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)', [profileId, formatId, type]);
  }

  removeProfileFormat(profileId: string, formatId: string) {
    this.db.run('DELETE FROM profile_formats WHERE profile_id = ? AND format_id = ?', [profileId, formatId]);
  }

  getProfileFormats(profileId: string) {
    console.log(`[db] getProfileFormats for ${profileId}`);
    const results = this.db.query(`
      SELECT cf.*, pf.type as profile_format_type
      FROM custom_formats cf
      JOIN profile_formats pf ON cf.id = pf.format_id
      WHERE pf.profile_id = ?
    `).all(profileId) as any[];
    console.log(`[db] results:`, results);
    return results;
  }
}

export const db = new DatabaseManager();
