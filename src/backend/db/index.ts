import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, and, like, sql, asc, inArray } from 'drizzle-orm';
import * as schema from './schema';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { extractShowTitleCandidates } from '../core/show_titles';

export const ConfigSchema = z.object({
  apiKeys: z.record(z.string(), z.string()).optional(),
  defaultProvider: z.enum(['tmdb', 'tvdb', 'anilist']),
  onCollision: z.enum(['overwrite', 'skip', 'version']).default('skip'),
  dryRun: z.boolean().default(false),
  seasonFolderFormat: z.string().default('Season {season}'),
  downloadClient: z.object({
    type: z.enum(['blackhole', 'torbox', 'none']).optional(),
    blackhole: z.object({
      outputFolder: z.string().optional(),
      watchFolder: z.string().optional(),
    }).optional(),
    torbox: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      inputFolder: z.string().optional(),
      outputFolder: z.string().optional(),
      concurrency: z.number().optional(),
    }).optional(),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const ProwlarrConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('').refine(
    v => v === '' || /^https?:\/\/.+/.test(v),
    { message: "Prowlarr URL must be a valid URL (e.g. http://localhost:9696)" },
  ),
  apiKey: z.string().default(''),
  syncLevel: z.enum(['full', 'addRemoveOnly', 'disabled']).default('full'),
  tags: z.array(z.number()).default([]),
});

export type ProwlarrConfig = z.infer<typeof ProwlarrConfigSchema>;

const NativeIndexerIdSchema = z.enum(['nyaa', 'subsplease', 'tpb', 'knaben', 'rarbg']);

export const NativeIndexerConfigSchema = z.object({
  id: NativeIndexerIdSchema,
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
});

export const NativeIndexersConfigSchema = z.array(NativeIndexerConfigSchema).default([]);

export type NativeIndexerConfig = z.infer<typeof NativeIndexerConfigSchema>;

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class DatabaseManager {
  public db: Database;
  public drizz: ReturnType<typeof drizzle>;
  private dbPath: string;

  constructor(dbPath = 'showflow.db') {
    this.dbPath = dbPath;
    this.db = new Database(this.dbPath);
    this.db.run('PRAGMA foreign_keys = ON');
    this.drizz = drizzle(this.db, { schema });
    this.init();
  }

  reload(altPath?: string) {
    this.db.close();
    this.dbPath = altPath ?? this.dbPath;
    this.db = new Database(this.dbPath);
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
        series_type TEXT DEFAULT 'standard',
        root_folder_path TEXT,
        sort_title TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        last_updated TEXT DEFAULT (datetime('now'))
      )
    `);
    // Migrate existing databases
    try { this.db.run(`ALTER TABLE shows ADD COLUMN series_type TEXT DEFAULT 'standard'`); } catch { }
    try { this.db.run(`ALTER TABLE shows DROP COLUMN config_json`); } catch { }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS show_providers (
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        provider_type TEXT NOT NULL DEFAULT 'local',
        provider_id TEXT NOT NULL,
        title TEXT,
        original_title TEXT,
        year INTEGER,
        metadata_json TEXT,
        is_primary INTEGER DEFAULT 0,
        is_metadata INTEGER DEFAULT 0,
        is_airtime INTEGER DEFAULT 0,
        last_synced TEXT,
        PRIMARY KEY (show_id, provider_type)
      )
    `);
    try { this.db.run(`ALTER TABLE show_providers ADD COLUMN is_metadata INTEGER DEFAULT 0`); } catch { }
    try { this.db.run(`ALTER TABLE show_providers ADD COLUMN is_airtime INTEGER DEFAULT 0`); } catch { }

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_show_providers_provider
      ON show_providers(provider_type, provider_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS show_titles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        language TEXT,
        title_type TEXT NOT NULL,
        provider_type TEXT NOT NULL DEFAULT 'local',
        created_at TEXT DEFAULT (datetime('now')),
        last_updated TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_show_titles_normalized_title
      ON show_titles(normalized_title)
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_show_titles_show_id
      ON show_titles(show_id)
    `);

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_show_titles_show_normalized_type
      ON show_titles(show_id, normalized_title, title_type, provider_type)
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
        provider_type TEXT NOT NULL DEFAULT 'local',
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
        indexers TEXT DEFAULT '{}',
        FOREIGN KEY (cutoff_quality_id) REFERENCES quality_definitions(id)
      )
    `);
    // Add indexers column on existing databases (safe to re-run)
    try { this.db.run(`ALTER TABLE quality_profiles ADD COLUMN indexers TEXT DEFAULT '{}'`); } catch { }

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
      CREATE TABLE IF NOT EXISTS profile_qualities (
        profile_id TEXT,
        quality_id TEXT,
        PRIMARY KEY (profile_id, quality_id),
        FOREIGN KEY (profile_id) REFERENCES quality_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (quality_id) REFERENCES quality_definitions(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS show_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_folder_path TEXT NOT NULL
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

    // Seed default quality definitions on first run
    this.seedDefaults();
    // Migrate old quality IDs (q1/q2/q3) to the current schema
    this.migrateQualityIds();
    this.backfillShowTitles();
  }

  private migrateQualityIds() {
    // Remove old quality IDs that don't match the current naming scheme
    this.db.run(`DELETE FROM quality_definitions WHERE id IN ('q1', 'q2', 'q3', 'q4')`);
  }

  private backfillShowTitles() {
    const rows = this.drizz
      .select({
        showId: schema.shows.id,
        showTitle: schema.shows.title,
        showOriginalTitle: schema.shows.original_title,
        providerType: schema.showProviders.provider_type,
        providerTitle: schema.showProviders.title,
        providerOriginalTitle: schema.showProviders.original_title,
        providerMetadataJson: schema.showProviders.metadata_json,
      })
      .from(schema.shows)
      .innerJoin(
        schema.showProviders,
        eq(schema.showProviders.show_id, schema.shows.id),
      )
      .all();

    for (const row of rows) {
      this.upsertShowTitle({
        showId: row.showId,
        title: row.showTitle,
        titleType: 'canonical',
        providerType: row.providerType,
      });

      if (row.showOriginalTitle) {
        this.upsertShowTitle({
          showId: row.showId,
          title: row.showOriginalTitle,
          titleType: 'original',
          providerType: row.providerType,
        });
      }

      if (row.providerTitle) {
        this.upsertShowTitle({
          showId: row.showId,
          title: row.providerTitle,
          titleType: 'provider',
          providerType: row.providerType,
        });
      }

      if (row.providerOriginalTitle) {
        this.upsertShowTitle({
          showId: row.showId,
          title: row.providerOriginalTitle,
          titleType: 'original',
          providerType: row.providerType,
        });
      }

      // Backfill aliases/translations from whatever provider metadata was
      // already stored, so shows added before this indexing existed also
      // get the fast exact-match path instead of always falling through to
      // fuzzy matching.
      if (row.providerMetadataJson) {
        let metadata: Record<string, unknown> | undefined;
        try {
          metadata = JSON.parse(row.providerMetadataJson);
        } catch {
          metadata = undefined;
        }

        if (metadata) {
          this.syncAllShowTitles(row.showId, row.providerType, { metadata });
        }
      }
    }
  }


  private seedDefaults() {
    const qualities: { id: string; name: string; rank: number }[] = [
      { id: 'q_sdtv', name: 'SDTV', rank: 1 },
      { id: 'q_dvd', name: 'DVD', rank: 2 },
      { id: 'q_480p', name: '480p', rank: 10 },
      { id: 'q_webrip_480p', name: 'WEBRip-480p', rank: 11 },
      { id: 'q_webdl_480p', name: 'WEBDL-480p', rank: 12 },
      { id: 'q_720p', name: '720p', rank: 20 },
      { id: 'q_hdtv_720p', name: 'HDTV-720p', rank: 21 },
      { id: 'q_webrip_720p', name: 'WEBRip-720p', rank: 22 },
      { id: 'q_webdl_720p', name: 'WEBDL-720p', rank: 23 },
      { id: 'q_bluray_720p', name: 'Bluray-720p', rank: 24 },
      { id: 'q_1080p', name: '1080p', rank: 30 },
      { id: 'q_hdtv_1080p', name: 'HDTV-1080p', rank: 31 },
      { id: 'q_webrip_1080p', name: 'WEBRip-1080p', rank: 32 },
      { id: 'q_webdl_1080p', name: 'WEBDL-1080p', rank: 33 },
      { id: 'q_bluray_1080p', name: 'Bluray-1080p', rank: 34 },
      { id: 'q_remux_1080p', name: 'Remux-1080p', rank: 35 },
      { id: 'q_2160p', name: '2160p', rank: 40 },
      { id: 'q_hdtv_2160p', name: 'HDTV-2160p', rank: 41 },
      { id: 'q_webrip_2160p', name: 'WEBRip-2160p', rank: 42 },
      { id: 'q_webdl_2160p', name: 'WEBDL-2160p', rank: 43 },
      { id: 'q_bluray_2160p', name: 'Bluray-2160p', rank: 44 },
      { id: 'q_remux_2160p', name: 'Remux-2160p', rank: 45 },
    ];
    for (const q of qualities) {
      this.db.run(
        'INSERT OR IGNORE INTO quality_definitions (id, name, rank) VALUES (?, ?, ?)',
        [q.id, q.name, q.rank]
      );
    }

    // Seed default custom formats
    const formats: { id: string; name: string; regex: string; score: number }[] = [
      { id: 'f_hdr', name: 'HDR', regex: 'HDR', score: 50 },
      { id: 'f_x265', name: 'x265', regex: 'x265', score: 10 },
      { id: 'f_hevc', name: 'HEVC', regex: 'HEVC', score: 10 },
      { id: 'f_h265', name: 'H265', regex: 'H265', score: 10 },
    ];
    for (const f of formats) {
      this.db.run(
        'INSERT OR IGNORE INTO custom_formats (id, name, regex, score) VALUES (?, ?, ?, ?)',
        [f.id, f.name, f.regex, f.score]
      );
    }

    // Seed default quality profiles
    // Standard — HDR bonus, x265 bonus, H265 bonus
    this.db.run(`INSERT OR IGNORE INTO quality_profiles (id, name) VALUES ('standard', 'Standard')`);
    for (const f of ['f_hdr', 'f_x265', 'f_h265']) {
      this.db.run(
        'INSERT OR IGNORE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)',
        ['standard', f, 'bonus']
      );
    }

    // Anime — x265, HEVC, and H265 bonuses (common for anime encodes)
    this.db.run(`INSERT OR IGNORE INTO quality_profiles (id, name) VALUES ('anime', 'Anime')`);
    for (const f of ['f_x265', 'f_hevc', 'f_h265']) {
      this.db.run(
        'INSERT OR IGNORE INTO profile_formats (profile_id, format_id, type) VALUES (?, ?, ?)',
        ['anime', f, 'bonus']
      );
    }
  }



  // ---- Shows -------------------------------------------------------------

  /**
 * Normalizes a title for deterministic database matching.
 *
 * Keep this algorithm aligned with Oracle's title normalization. It removes
 * punctuation and release-style separators while preserving Unicode letters
 * and numbers, allowing translated and romanized names to match reliably.
 */
  private normalizeShowTitle(title: string): string {
    return title
      .normalize('NFKC')
      .replace(/[._]+/g, ' ')
      .replace(/[‐‑‒–—]/g, '-')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  /**
   * Returns all provider-linked title candidates for an exact normalized
   * title. Provider rows are included so the caller receives the external ID
   * needed for getEpisode(), not only the local show UUID.
   */
  findShowsByNormalizedTitle(normalizedTitle: string) {
    return this.drizz
      .select({
        showId: schema.shows.id,
        showTitle: schema.shows.title,
        showOriginalTitle: schema.shows.original_title,
        showYear: schema.shows.year,
        showSeriesType: schema.shows.series_type,

        providerType: schema.showProviders.provider_type,
        providerId: schema.showProviders.provider_id,
        providerTitle: schema.showProviders.title,
        providerOriginalTitle: schema.showProviders.original_title,
        providerMetadataJson: schema.showProviders.metadata_json,
        isPrimary: schema.showProviders.is_primary,

        matchedTitle: schema.showTitles.title,
        matchedTitleType: schema.showTitles.title_type,
        matchedTitleLanguage: schema.showTitles.language,
      })
      .from(schema.showTitles)
      .innerJoin(
        schema.shows,
        eq(schema.showTitles.show_id, schema.shows.id),
      )
      .innerJoin(
        schema.showProviders,
        eq(schema.showProviders.show_id, schema.shows.id),
      )
      .where(eq(schema.showTitles.normalized_title, normalizedTitle))
      .orderBy(
        asc(schema.showTitles.title_type),
        asc(schema.showProviders.is_primary),
      )
      .all();
  }

  /**
   * Returns all stored title candidates. This is used only as a fallback for
   * fuzzy local matching after exact normalized-title lookup has failed.
   *
   * For very large libraries, replace this with a narrowed candidate query or
   * SQLite FTS table. Exact matching remains indexed and cheap.
   */
  getLocalShowCandidates() {
    return this.drizz
      .select({
        showId: schema.shows.id,
        showTitle: schema.shows.title,
        showOriginalTitle: schema.shows.original_title,
        showYear: schema.shows.year,
        showSeriesType: schema.shows.series_type,

        providerType: schema.showProviders.provider_type,
        providerId: schema.showProviders.provider_id,
        providerTitle: schema.showProviders.title,
        providerOriginalTitle: schema.showProviders.original_title,
        providerMetadataJson: schema.showProviders.metadata_json,
        isPrimary: schema.showProviders.is_primary,

        knownTitle: schema.showTitles.title,
        knownTitleType: schema.showTitles.title_type,
        knownTitleLanguage: schema.showTitles.language,
      })
      .from(schema.shows)
      .innerJoin(
        schema.showProviders,
        eq(schema.showProviders.show_id, schema.shows.id),
      )
      .leftJoin(
        schema.showTitles,
        eq(schema.showTitles.show_id, schema.shows.id),
      )
      .all();
  }

  /**
   * Inserts a title without overwriting an existing source title. User titles
   * should use `titleType: 'user'`; provider titles should use the originating
   * provider type.
   */
  upsertShowTitle(input: {
    showId: string;
    title: string;
    titleType:
    | 'canonical'
    | 'original'
    | 'romanized'
    | 'translation'
    | 'alias'
    | 'provider'
    | 'user';
    language?: string | null;
    providerType?: string | null;
  }) {
    const title = input.title.trim();
    const normalizedTitle = this.normalizeShowTitle(title);

    if (!title || !normalizedTitle) {
      return;
    }

    this.drizz
      .insert(schema.showTitles)
      .values({
        show_id: input.showId,
        title,
        normalized_title: normalizedTitle,
        language: input.language ?? null,
        title_type: input.titleType,
        provider_type: input.providerType ?? 'local',
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Seeds canonical and original titles whenever a show is saved. This makes
   * existing and newly added shows available to the local-first resolver.
   */
  private syncCoreShowTitles(input: {
    showId: string;
    title: string;
    originalTitle?: string;
    providerType: string;
  }) {
    this.upsertShowTitle({
      showId: input.showId,
      title: input.title,
      titleType: 'canonical',
      providerType: input.providerType,
    });

    if (input.originalTitle?.trim()) {
      this.upsertShowTitle({
        showId: input.showId,
        title: input.originalTitle,
        titleType: 'original',
        providerType: input.providerType,
      });
    }
  }

  /**
   * Indexes every alias/translation/romanized-title variant a provider knows
   * about into `show_titles`, so a future file for the same show hits the
   * fast indexed exact-match SQL lookup (findShowsByNormalizedTitle) instead
   * of always falling through to the slower fuzzy pass over every local show
   * (getLocalShowCandidates). Safe to call redundantly - upsertShowTitle
   * no-ops on an existing (show, normalized title, type, provider) row.
   */
  syncAllShowTitles(
    showId: string,
    providerType: string,
    show: {
      title?: string;
      originalTitle?: string;
      romanizedTitle?: string;
      aliases?: string[];
      alternateTitles?: string[];
      translations?: Record<string, string>;
      metadata?: Record<string, unknown>;
    },
  ) {
    const titles = extractShowTitleCandidates(show as any);

    for (const title of titles) {
      this.upsertShowTitle({
        showId,
        title,
        titleType: 'alias',
        providerType,
      });
    }
  }


  saveShow(show: { uuid: string, providerId: string, type: string, title: string, profile?: string, showProfileId?: string, config: any, year?: number, originalTitle?: string, romanizedTitle?: string, metadata?: any, rootFolderPath?: string, seriesType?: string }) {
    const profile = this.resolveProfileId(show.profile) ?? show.profile ?? undefined;
    // The folder destination is resolved once at add-time from the chosen
    // show_profiles preset (or an explicit rootFolderPath override) and
    // stored directly on the show - we don't keep re-deriving it from an ID
    // later, since show.profile no longer means "which folder preset".
    const rootFolderPath = show.rootFolderPath ?? (show.showProfileId ? this.getShowProfileRootFolder(show.showProfileId) : null);
    const seriesType = show.seriesType ?? 'standard';

    this.drizz.insert(schema.shows).values({
      id: show.uuid,
      title: show.title,
      original_title: show.originalTitle ?? null,
      year: show.year ?? null,
      profile,
      series_type: seriesType,
      root_folder_path: rootFolderPath,
    }).onConflictDoUpdate({
      target: schema.shows.id,
      set: {
        title: show.title,
        original_title: show.originalTitle ?? null,
        year: show.year ?? null,
        profile,
        series_type: seriesType,
        root_folder_path: rootFolderPath,
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
        is_metadata: (providerCount?.c ?? 0) === 0 ? 1 : 0,
        is_airtime: (providerCount?.c ?? 0) === 0 ? 1 : 0,
      }).run();
    }
    this.syncCoreShowTitles({
      showId: show.uuid,
      title: show.title,
      originalTitle: show.originalTitle,
      providerType: show.type,
    });

    this.syncAllShowTitles(show.uuid, show.type, {
      title: show.title,
      originalTitle: show.originalTitle,
      romanizedTitle: show.romanizedTitle,
      metadata: show.metadata,
    });
  }

  updateShowSyncData(showId: string, providerType: string, data: { title?: string, year?: number, originalTitle?: string, romanizedTitle?: string, metadata?: any }) {
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

    if (data.title) {
      this.syncCoreShowTitles({
        showId,
        title: data.title,
        originalTitle: data.originalTitle,
        providerType,
      });
    } else if (data.originalTitle) {
      this.upsertShowTitle({
        showId,
        title: data.originalTitle,
        titleType: 'original',
        providerType,
      });
    }

    // Keep the alias/translation/romanized-title index current so future
    // files for this show hit the fast exact-match lookup rather than the
    // fuzzy fallback pass. Only worth doing when there's actually new title
    // material to index (title/originalTitle changed, or fresh metadata came
    // back from a sync).
    if (data.title || data.originalTitle || data.romanizedTitle || data.metadata) {
      this.syncAllShowTitles(showId, providerType, {
        title: data.title,
        originalTitle: data.originalTitle,
        romanizedTitle: data.romanizedTitle,
        metadata: data.metadata,
      });
    }

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
      series_type: row.series_type ?? 'standard',
      provider_id: primaryProvider?.provider_id || row.id,
      provider_type: primaryProvider?.provider_type || null,
      provider_metadata: primaryProvider?.metadata_json || null,
      uuid: row.id,
    } as any;
  }

  getShowConfig(showId: string): Record<string, any> {
    const show = this.getShow(showId);
    if (!show) return {};
    const config: Record<string, any> = {
      seriesType: show.series_type ?? 'standard',
    };
    const providers = this.drizz.select().from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, showId)).all() as any[];
    for (const p of providers) {
      if (p.is_metadata) config.metadataProvider = p.provider_type;
      if (p.is_airtime) config.airtimeProvider = p.provider_type;
    }
    return config;
  }

  getProviderForRole(showId: string, role: 'metadata' | 'airtime'): { providerType: string; providerId: string } | null {
    const flag = role === 'metadata' ? 'is_metadata' : 'is_airtime';
    const provider = this.drizz.select().from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders[flag as 'is_metadata'], 1),
      )).get();

    if (provider) {
      return { providerType: provider.provider_type, providerId: provider.provider_id };
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
    const flag = role === 'metadata' ? 'is_metadata' : 'is_airtime';

    // Clear the role from any provider that currently has it
    this.drizz.update(schema.showProviders).set({ [flag]: 0 })
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders[flag as 'is_metadata'], 1),
      )).run();

    // Set it on the target provider
    if (active) {
      this.drizz.update(schema.showProviders).set({ [flag]: 1 })
        .where(and(
          eq(schema.showProviders.show_id, showId),
          eq(schema.showProviders.provider_type, providerType),
        )).run();
    }
  }

  listShowProvidersWithRoles(showId: string): any[] {
    const providers = this.drizz.select().from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, showId))
      .all() as any[];

    return providers.map(p => ({
      ...p,
      roles: {
        metadata: !!p.is_metadata,
        airtime: !!p.is_airtime,
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

      this.drizz.insert(schema.showProviders).values(values as any).run();
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

  /**
   * Episodes that are tracked, have already aired, and have no file on
   * disk yet - the "you're missing these" list. Ordered most-recently-aired
   * first so the freshest gaps surface at the top.
   */
  listMissingEpisodes() {
    const result = this.drizz.select({
      episode: schema.episodes,
      show_title: schema.shows.title,
    })
      .from(schema.episodes)
      .leftJoin(schema.shows, eq(schema.episodes.show_id, schema.shows.id))
      .where(and(
        eq(schema.episodes.is_tracked, 1),
        sql`${schema.episodes.air_date} IS NOT NULL`,
        sql`${schema.episodes.air_date} <= datetime('now')`,
        sql`(${schema.episodes.file_path} IS NULL OR ${schema.episodes.file_path} = '')`,
      ))
      .orderBy(sql`${schema.episodes.air_date} DESC`)
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

  listShowEpisodes(showId: string): { season_number: number; episode_number: number; file_path: string | null }[] {
    return this.drizz.select({
      season_number: schema.episodes.season_number,
      episode_number: schema.episodes.episode_number,
      file_path: schema.episodes.file_path,
    }).from(schema.episodes)
      .where(eq(schema.episodes.show_id, showId))
      .all() as any;
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

  updateShow(showId: string, updates: Partial<{ title: string, profile: string, seriesType: string, config: Record<string, any>, rootFolderPath: string }>) {
    const setData: Record<string, any> = { last_updated: sql`(datetime('now'))` };
    if (updates.title !== undefined) setData.title = updates.title;
    if (updates.profile !== undefined) setData.profile = updates.profile;
    if (updates.seriesType !== undefined) setData.series_type = updates.seriesType;
    if (updates.config?.seriesType !== undefined) setData.series_type = updates.config.seriesType;
    if (updates.rootFolderPath !== undefined) setData.root_folder_path = updates.rootFolderPath;

    this.drizz.update(schema.shows).set(setData)
      .where(eq(schema.shows.id, showId)).run();
  }

  removeShow(showId: string) {
    this.drizz.delete(schema.shows)
      .where(eq(schema.shows.id, showId)).run();
  }

  removeShows(ids: string[]) {
    if (ids.length === 0) return;
    this.drizz.delete(schema.shows)
      .where(inArray(schema.shows.id, ids)).run();
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

  removeProcessedFile(hash: string) {
    this.db.run('DELETE FROM processed_files WHERE file_hash = ?', [hash]);
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

  cleanupOldLogs(beforeDate: string) {
    const result = this.db.run('DELETE FROM audit_logs WHERE timestamp < ?', [beforeDate]);
    return result.changes;
  }

  cleanupExpiredCache() {
    const result = this.db.run('DELETE FROM metadata_cache WHERE expires_at < CURRENT_TIMESTAMP');
    return result.changes;
  }

  // ---- Show Profiles -----------------------------------------------------

  listShowProfiles(): { id: string; name: string; root_folder_path: string }[] {
    return this.db.query('SELECT * FROM show_profiles ORDER BY name ASC').all() as { id: string; name: string; root_folder_path: string }[];
  }

  saveShowProfile(id: string, name: string, rootFolderPath: string) {
    this.db.run('INSERT OR REPLACE INTO show_profiles (id, name, root_folder_path) VALUES (?, ?, ?)', [id, name, rootFolderPath]);
  }

  removeShowProfile(id: string) {
    this.db.run('DELETE FROM show_profiles WHERE id = ?', [id]);
  }

  getShowProfileRootFolder(profileId: string): string | null {
    const row = this.db.query('SELECT root_folder_path FROM show_profiles WHERE id = ?').get(profileId) as { root_folder_path: string } | undefined;
    return row?.root_folder_path ?? null;
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

  removeQuality(id: string) {
    this.db.run('DELETE FROM quality_definitions WHERE id = ?', [id]);
  }

  listQualities() {
    return this.db.query('SELECT * FROM quality_definitions ORDER BY rank DESC').all() as any[];
  }

  saveProfile(p: { id: string, name: string, cutoffId?: string, indexers?: string }) {
    const indexersStr = p.indexers ?? '{}';
    this.db.run(
      'INSERT OR REPLACE INTO quality_profiles (id, name, cutoff_quality_id, indexers) VALUES (?, ?, ?, ?)',
      [p.id, p.name, p.cutoffId ?? null, indexersStr]
    );
  }

  saveProfileIndexers(id: string, indexers: Record<string, string[]>) {
    this.db.run(
      'UPDATE quality_profiles SET indexers = ? WHERE id = ?',
      [JSON.stringify(indexers), id]
    );
  }

  getProfileIndexers(id: string): string[] {
    const row = this.db.query('SELECT indexers FROM quality_profiles WHERE id = ?').get(id) as any;
    if (!row?.indexers) return [];
    try {
      return normalizeIndexers(JSON.parse(row.indexers));
    } catch {
      return [];
    }
  }

  resolveProfileId(id: string | null | undefined): string | undefined {
    if (id && this.getProfile(id)) return id;
    const profiles = this.listProfiles();
    return profiles.length > 0 ? profiles[0].id : undefined;
  }

  getProfile(id: string) {
    const row = this.db.query('SELECT * FROM quality_profiles WHERE id = ?').get(id) as any;
    if (row?.indexers) {
      try { row.indexers = normalizeIndexers(JSON.parse(row.indexers)); } catch { row.indexers = []; }
    }
    return row;
  }

  removeProfile(id: string) {
    this.db.run('DELETE FROM quality_profiles WHERE id = ?', [id]);
  }

  listProfiles() {
    const rows = this.db.query('SELECT * FROM quality_profiles').all() as any[];
    for (const row of rows) {
      if (row.indexers) {
        try { row.indexers = normalizeIndexers(JSON.parse(row.indexers)); } catch { row.indexers = []; }
      }
    }
    return rows;
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

  removeCustomFormat(id: string) {
    this.db.run('DELETE FROM custom_formats WHERE id = ?', [id]);
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
    return this.db.query(`
      SELECT cf.*, pf.type as profile_format_type
      FROM custom_formats cf
      JOIN profile_formats pf ON cf.id = pf.format_id
      WHERE pf.profile_id = ?
    `).all(profileId) as any[];
  }

  addProfileQuality(profileId: string, qualityId: string) {
    this.db.run('INSERT OR IGNORE INTO profile_qualities (profile_id, quality_id) VALUES (?, ?)', [profileId, qualityId]);
  }

  removeProfileQuality(profileId: string, qualityId: string) {
    this.db.run('DELETE FROM profile_qualities WHERE profile_id = ? AND quality_id = ?', [profileId, qualityId]);
  }

  /**
   * Qualities this profile will accept. An empty result means "unrestricted"
   * (no allow-list has been configured yet) rather than "nothing allowed" -
   * QualityEngine treats those two cases differently.
   */
  getProfileQualities(profileId: string) {
    return this.db.query(`
      SELECT qd.*
      FROM quality_definitions qd
      JOIN profile_qualities pq ON qd.id = pq.quality_id
      WHERE pq.profile_id = ?
      ORDER BY qd.rank DESC
    `).all(profileId) as any[];
  }
}

function normalizeIndexers(v: unknown): string[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [...(Array.isArray((v as any).tv) ? (v as any).tv : []), ...(Array.isArray((v as any).anime) ? (v as any).anime : [])];
  return [];
}

export const db = new DatabaseManager();
