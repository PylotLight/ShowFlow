import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
  blob,
} from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

export const shows = sqliteTable('shows', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  original_title: text('original_title'),
  year: integer('year'),
  /**
   * Learned offset (minutes) between an episode's expected air datetime and
   * when a release actually first appears on indexers, based on the show's
   * historical grads (grabbed_releases.publish_date vs the episode's air
   * datetime). Null until enough evidence exists; expected_release_at on
   * episodes falls back to a sensible default (<<~45 min) for unaired shows.
   */
  release_delay_minutes: integer('release_delay_minutes'),
  // --- Legacy columns (pre-Library-Type model) ---
  // Kept and still written to during the migration window described in
  // docs/design-brief-platform-ux-systems.md §1 - `library_type_id` below is
  // the new source of truth once a show has one, but these three stay
  // populated in parallel until all read paths (grabber_service quality
  // resolution, Add Show, Sonarr import mapping, library_scanner root-folder
  // lookup) have been switched over and verified. Do not add new reads of
  // these three columns; resolve via library_type_id + libraryTypes instead.
  profile: text('profile').default('standard'),
  series_type: text('series_type').default('standard'),
  root_folder_path: text('root_folder_path'),
  // --- Library Type model ---
  // Bundles root folder + indexer set + quality profile into one selector.
  // Nullable during migration (existing rows are backfilled by the
  // migration's data pass - see migrations/ + the seed step in init.ts -
  // but nullable rather than NOT NULL so a partially-migrated DB never
  // fails to boot). A show with a library_type_id set resolves its quality
  // profile via libraryTypes.quality_profile_id, NOT via `profile` above.
  library_type_id: text('library_type_id').references(() => libraryTypes.id),
  sort_title: text('sort_title'),
  added_at: text('added_at').default(sql`(datetime('now'))`),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
});

// ---- Library Types ----
//
// Replaces picking a quality profile AND a series type/root-folder
// separately (design-brief-platform-ux-systems.md §1). A Library Type
// bundles:
//   - a default root folder (root_folder_path, formerly show_profiles-only)
//   - an associated indexer set (moved out of quality_profiles.indexers)
//   - a referenced quality profile (quality_profiles.id, now purely about
//     quality/format rules - indexer routing no longer lives there)
//
// `indexers` uses the same JSON shape quality_profiles.indexers used to
// (see normalizeIndexers() in db/config.ts) so existing indexer-selection
// UI and grabber_service lookups need minimal reshaping.
//
// Migration note: seed data for this table comes from existing
// quality_profiles rows during migration - a profile that had anime-flagged
// indexers becomes an auto-generated "Anime" Library Type. See
// docs/design-brief-platform-ux-systems.md §1 "Migration notes" and the
// seedDefaultLibraryTypes() step in init.ts.
export const libraryTypes = sqliteTable('library_types', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  root_folder_path: text('root_folder_path'),
  quality_profile_id: text('quality_profile_id').references(() => qualityProfiles.id),
  /** Same JSON shape as the legacy quality_profiles.indexers column. */
  indexers: text('indexers').default('{}'),
  is_default: integer('is_default').default(0),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  uniqueName: uniqueIndex('uq_library_types_name').on(table.name),
}));

export const libraryTypesRelations = relations(libraryTypes, ({ many, one }) => ({
  shows: many(shows),
  qualityProfile: one(qualityProfiles, {
    fields: [libraryTypes.quality_profile_id],
    references: [qualityProfiles.id],
  }),
}));

export const showProviders = sqliteTable('show_providers', {
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  provider_type: text('provider_type').notNull(),
  provider_id: text('provider_id').notNull(),
  title: text('title'),
  original_title: text('original_title'),
  year: integer('year'),
  metadata_json: text('metadata_json'),
  is_primary: integer('is_primary').default(0),
  is_metadata: integer('is_metadata').default(0),
  is_airtime: integer('is_airtime').default(0),
  last_synced: text('last_synced'),
}, (table) => ({
  pk: primaryKey({
    columns: [table.show_id, table.provider_type],
  }),
  uniqueProvider: uniqueIndex('uq_show_providers_provider').on(
    table.provider_type,
    table.provider_id,
  ),
  showIdIndex: index('idx_show_providers_show_id').on(table.show_id),
}));

/**
 * Canonical, original, translated, romanized, provider-derived, and
 * user-provided titles associated with a local show.
 *
 * `normalized_title` is generated by application code. SQLite's built-in
 * lower()/LIKE behavior is not sufficient for punctuation, Unicode forms,
 * and transliterated anime titles.
 */
export const showTitles = sqliteTable('show_titles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  normalized_title: text('normalized_title').notNull(),
  language: text('language'),
  title_type: text('title_type').notNull(),
  provider_type: text('provider_type'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
}, (table) => ({
  normalizedTitleIndex: index('idx_show_titles_normalized_title').on(
    table.normalized_title,
  ),
  showIdIndex: index('idx_show_titles_show_id').on(table.show_id),
  uniqueShowTitle: uniqueIndex('uq_show_titles_show_normalized_type').on(
    table.show_id,
    table.normalized_title,
    table.title_type,
    table.provider_type,
  ),
}));

export const seasons = sqliteTable('seasons', {
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number').notNull(),
  title: text('title'),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
}, (table) => ({
  pk: primaryKey({
    columns: [table.show_id, table.season_number],
  }),
}));

export const episodes = sqliteTable('episodes', {
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number').notNull(),
  episode_number: integer('episode_number').notNull(),
  absolute_number: integer('absolute_number'),
  title: text('title'),
  file_path: text('file_path'),
  is_tracked: integer('is_tracked').default(0),
  air_date: text('air_date'),
  /**
   * Time-of-day (HH:MM) the episode is scheduled to air, captured from the
   * airtime provider (TVDB airsTime, AniList airingAt) when available. The
   * legacy air_date column often holds a date-only value from TMDB; combining
   * this with air_date gives the "air window" start for release forecasting.
   */
  air_time: text('air_time'),
  /**
   * ISO timestamp for when this episode's release is *expected* to be
   * available on indexers. Computed as the air datetime plus the show's
   * learned release delay (see shows.release_delay_minutes, default ~45 min).
   * When the actual release publish date is observed at grab time this gets
   * overwritten with the real publish time.
   */
  expected_release_at: text('expected_release_at'),
  search_mode: text('search_mode').default('auto'),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
}, (table) => ({
  pk: primaryKey({
    columns: [table.show_id, table.season_number, table.episode_number],
  }),
}));

export const showArtworks = sqliteTable('show_artworks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  provider_type: text('provider_type').notNull().default('local'),
  artwork_type: text('artwork_type').notNull(),
  image_url: text('image_url').notNull(),
  width: integer('width'),
  height: integer('height'),
  thumbnail: text('thumbnail'),
  content_type: text('content_type'),
  data: blob('data'),
}, (table) => ({
  uniqueArtwork: uniqueIndex('uq_show_artworks').on(
    table.show_id,
    table.provider_type,
    table.artwork_type,
  ),
}));

export const showsRelations = relations(shows, ({ many }) => ({
  providers: many(showProviders),
  titles: many(showTitles),
  seasons: many(seasons),
  episodes: many(episodes),
  episodeFiles: many(episodeFiles),
  artworks: many(showArtworks),
}));

export const showProvidersRelations = relations(showProviders, ({ one }) => ({
  show: one(shows, {
    fields: [showProviders.show_id],
    references: [shows.id],
  }),
}));

export const showTitlesRelations = relations(showTitles, ({ one }) => ({
  show: one(shows, {
    fields: [showTitles.show_id],
    references: [shows.id],
  }),
}));

// ---- Episode mapping (anime season-splits) -------------------------------
//
// Two-tier anime episode mapping (see docs/issues-tracking.md #4):
//  - Tier 1 (primary): TheXem rows keyed by scene season/episode, each with
//    the anidb + provider-native (target) equivalents. Fixes the Honzuki
//    class of problem where a release is tagged `S04E17` but TVDB lists the
//    show as one 60-episode S01 (the row resolves scene S04E17 -> tvdb
//    S01E53).
//  - Tier 2 (fallback): self-managed rows seeded from AniDB/anilist for
//    shows TheXem doesn't have. Same table; `scene_*` columns stay NULL.
//
// `locked` marks a row the user has confirmed/fixed by hand — the sync job
// must not overwrite it. `conflict_json` records cross-source disagreements
// (structure splits, episode counts) that surface the mapping badge.

export const episodeMappings = sqliteTable('episode_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  tvdb_id: text('tvdb_id'),
  scene_season: integer('scene_season'),
  scene_episode: integer('scene_episode'),
  scene_absolute: integer('scene_absolute'),
  anidb_season: integer('anidb_season'),
  anidb_episode: integer('anidb_episode'),
  anidb_absolute: integer('anidb_absolute'),
  target_season: integer('target_season'),
  target_episode: integer('target_episode'),
  target_absolute: integer('target_absolute'),
  source: text('source').notNull().default('thexem'),
  locked: integer('locked').default(0),
  conflict_json: text('conflict_json'),
  scraped_at: text('scraped_at').default(sql`(datetime('now'))`),
}, (table) => ({
  showIdIndex: index('idx_episode_mappings_show').on(table.show_id),
  tvdbIndex: index('idx_episode_mappings_tvdb').on(table.tvdb_id),
}));

export const episodeMappingsRelations = relations(episodeMappings, ({ one }) => ({
  show: one(shows, {
    fields: [episodeMappings.show_id],
    references: [shows.id],
  }),
}));

/**
 * Per-show episode-mapping configuration + derived health.
 *
 * A missing row falls back to the default: `enabled = (series_type == 'anime')`
 * so anime shows get the mapping ON by default with zero backfill, while
 * standard shows are untouched. A row is only written when the user overrides
 * the toggle or a sync updates health/source.
 */
export const episodeMappingConfig = sqliteTable('episode_mapping_config', {
  show_id: text('show_id')
    .primaryKey()
    .references(() => shows.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').default(0),
  source: text('source').default('thexem'),
  health: text('health').default('none'), // 'none' | 'ok' | 'conflicts' | 'missing' | 'error'
  health_detail: text('health_detail'),
  last_synced: text('last_synced'),
  last_error: text('last_error'),
});

export const episodeMappingConfigRelations = relations(episodeMappingConfig, ({ one }) => ({
  show: one(shows, {
    fields: [episodeMappingConfig.show_id],
    references: [shows.id],
  }),
}));

export const seasonsRelations = relations(seasons, ({ one }) => ({
  show: one(shows, {
    fields: [seasons.show_id],
    references: [shows.id],
  }),
}));

// ---- Processed files (dedup) ----

export const processedFiles = sqliteTable('processed_files', {
  file_hash: text('file_hash').primaryKey(),
  original_path: text('original_path'),
  final_path: text('final_path'),
  timestamp: text('timestamp').default(sql`(CURRENT_TIMESTAMP)`),
});

// ---- Grabbed releases (series -> release -> episode tracking) ----------
//
// Records which release was grabbed for which show/episode, so that when a
// file later lands in the watch folder with a generic or single-word episode
// name that the filename parser can't resolve on its own, the import step can
// narrow the search to the exact series it was grabbed for instead of failing.
// See also drag-based hint resolution in oracle.ts/blackhole.ts.
export const grabbedReleases = sqliteTable('grabbed_releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id').notNull(),
  season_number: integer('season_number'),
  episode_number: integer('episode_number'),
  release_title: text('release_title').notNull(),
  normalized_title: text('normalized_title').notNull(),
  indexer_name: text('indexer_name'),
  /**
   * ISO timestamp of when the indexer actually published this release. Used
   * both for provenance display (feature: file/release details) and to learn
   * each show's typical release delay after airing (air window forecasting).
   */
  publish_date: text('publish_date'),
  grabbed_at: text('grabbed_at').default(sql`(datetime('now'))`),
}, (table) => ({
  releaseTitleIndex: index('idx_grabbed_releases_title').on(table.normalized_title),
  showIndex: index('idx_grabbed_releases_show').on(table.show_id),
}));

// ---- On-disk files (provenance) ------------------------------------------
//
// What's actually stored for each episode and which release it came from
// (vs. a file imported directly into the watch folder with no grab). Powers
// the "available" detail on the show detail page and the dashboard, so users
// can see the granular stored file / release instead of just a green dot.
//
// Appended on every import (one row per episode a file maps to - a season
// pack writes N rows), so a file can be re-tracked across upgrades. The most
// recent row per (show, season, episode) with is_current=1 is the live file;
// older rows remain as history.
export const episodeFiles = sqliteTable('episode_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number').notNull(),
  episode_number: integer('episode_number').notNull(),
  /** The on-disk path ShowFlow itself stored to (final path the file was
   *  moved/renamed into, e.g. inside the show's library root folder). */
  file_path: text('file_path').notNull(),
  /** Original basename the file carried when it entered the pipeline (before
   *  ShowFlow renames it into the library). This is also the release title for
   *  a direct import. */
  original_name: text('original_name').notNull(),
  /** Size of the file in bytes at import time. */
  file_size: integer('file_size'),
  /** 'release' = was grabbed from an indexer (release_title/indexer set);
   *  'import' = placed/dropped directly into the pipeline with no grab. */
  source_kind: text('source_kind').default('import'),
  /** Release title this file came from (indexer-provided for grabs; the
   *  original filename for direct imports). Null for unknown. */
  release_title: text('release_title'),
  /** Indexer (Prowlarr/Native) name that supplied a grabbed release. */
  indexer_name: text('indexer_name'),
  /** publishDate of the release at grab time (indexer-derived). */
  publish_date: text('publish_date'),
  /** When the file was imported/moved into the library. */
  imported_at: text('imported_at').default(sql`(datetime('now'))`),
  /** 1 for the live file, 0 for superseded history rows. */
  is_current: integer('is_current').default(1),
  // --- Probed media info (feature: stored-episode media badges) ------------
  // Populated by src/backend/core/media_probe.ts using mediabunny (a pure-TS
  // demuxer - no external ffprobe binary, which the distroless image can't
  // run). Kept as plain columns so upgrade decisions and badges can compare
  // resolution/bitrate without re-reading the file; a null value means "not
  // probed yet" (backfilled on scan/import).
  /** Container format name, e.g. 'Matroska' or ISOBMFF-style. */
  container: text('container'),
  /** Display height in pixels (post aspect/rotation), proxy for 1080p/2160p. */
  video_width: integer('video_width'),
  /** Display width in pixels (post aspect/rotation). */
  video_height: integer('video_height'),
  /** Primary video codec, e.g. 'hevc' / 'h264' / 'av1'. */
  video_codec: text('video_codec'),
  /** Best-guess frames per second. */
  video_fps: integer('video_fps'),
  /** 1 if the video carries HDR color metadata. */
  hdr: integer('hdr'),
  /** Audio codec of the first audio track, e.g. 'eac3' / 'truehd' / 'aac'. */
  audio_codec: text('audio_codec'),
  /** Channel count of the first audio track (6 == 5.1). */
  audio_channels: integer('audio_channels'),
  /** Duration in seconds. */
  duration_seconds: integer('duration_seconds'),
  /** Overall average bitrate in bits/sec (fileSize*8/duration when the
   *  container carries none). */
  bitrate_kbps: integer('bitrate_kbps'),
  /** When the file was last probed (null = never). */
  probed_at: text('probed_at'),
}, (table) => ({
  showIndex: index('idx_episode_files_show').on(table.show_id),
  episodeIndex: index('idx_episode_files_episode').on(table.show_id, table.season_number, table.episode_number),
  currentIndex: index('idx_episode_files_current').on(table.is_current),
}));

export const episodeFilesRelations = relations(episodeFiles, ({ one }) => ({
  show: one(shows, {
    fields: [episodeFiles.show_id],
    references: [shows.id],
  }),
}));

// ---- Metadata cache ----

export const metadataCache = sqliteTable('metadata_cache', {
  cache_key: text('cache_key').primaryKey(),
  raw_json: text('raw_json'),
  expires_at: text('expires_at'),
});

// ---- Scheduled tasks ----

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  name: text('name').primaryKey(),
  interval_minutes: integer('interval_minutes'),
  last_execution: text('last_execution'),
  last_duration_ms: integer('last_duration_ms'),
  next_execution: text('next_execution'),
  enabled: integer('enabled').default(1),
});

// ---- Quality definitions ----

export const qualityDefinitions = sqliteTable('quality_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rank: integer('rank').default(0),
  min_size: integer('min_size'),
  max_size: integer('max_size'),
});

// ---- Quality profiles ----

export const qualityProfiles = sqliteTable('quality_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cutoff_quality_id: text('cutoff_quality_id').references(() => qualityDefinitions.id),
});

// ---- Custom formats ----

export const customFormats = sqliteTable('custom_formats', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  regex: text('regex').notNull(),
  score: integer('score').default(0),
});

// ---- Profile <-> format / quality mapping ----

export const profileFormats = sqliteTable('profile_formats', {
  profile_id: text('profile_id')
    .notNull()
    .references(() => qualityProfiles.id, { onDelete: 'cascade' }),
  format_id: text('format_id')
    .notNull()
    .references(() => customFormats.id, { onDelete: 'cascade' }),
  type: text('type').default('bonus'),
}, (table) => ({
  pk: primaryKey({ columns: [table.profile_id, table.format_id] }),
}));

export const profileQualities = sqliteTable('profile_qualities', {
  profile_id: text('profile_id')
    .notNull()
    .references(() => qualityProfiles.id, { onDelete: 'cascade' }),
  quality_id: text('quality_id')
    .notNull()
    .references(() => qualityDefinitions.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.profile_id, table.quality_id] }),
}));

export const qualityProfilesRelations = relations(qualityProfiles, ({ many }) => ({
  formats: many(profileFormats),
  qualities: many(profileQualities),
}));

export const profileFormatsRelations = relations(profileFormats, ({ one }) => ({
  profile: one(qualityProfiles, { fields: [profileFormats.profile_id], references: [qualityProfiles.id] }),
  format: one(customFormats, { fields: [profileFormats.format_id], references: [customFormats.id] }),
}));

export const profileQualitiesRelations = relations(profileQualities, ({ one }) => ({
  profile: one(qualityProfiles, { fields: [profileQualities.profile_id], references: [qualityProfiles.id] }),
  quality: one(qualityDefinitions, { fields: [profileQualities.quality_id], references: [qualityDefinitions.id] }),
}));

// ---- Show profiles (root-folder presets) ----

export const showProfiles = sqliteTable('show_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  root_folder_path: text('root_folder_path').notNull(),
});

// ---- Settings (key/value) ----

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ---- Audit logs (generic, free-text system log - predates the pipeline event log below) ----

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').default(sql`(CURRENT_TIMESTAMP)`),
  event_type: text('event_type'),
  entity_type: text('entity_type'),
  entity_id: text('entity_id'),
  message: text('message'),
  metadata_json: text('metadata_json'),
});

// ---- Pipeline event log ----
//
// Append-only per-item log of state transitions and decisions. This is the
// shared backend primitive behind:
//   - the Kanban pipeline view (current stage = latest event per item)
//   - the "why isn't this downloading" trace (full event history for one item)
//   - the Failure Diagnosis Assistant (reason_code -> diagnosis lookup)
//
// See src/backend/core/pipeline/reason_codes.ts for the stage/code/category
// taxonomy these columns draw from. Rows are intentionally cheap/frequent
// (one search can produce several), so this table should get a retention
// policy (see cleanupOldPipelineEvents) same as audit_logs already has.
export const pipelineEvents = sqliteTable('pipeline_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id')
    .notNull()
    .references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number'),
  episode_number: integer('episode_number'),
  /** Coarse pipeline stage - powers the Kanban column this item sits in. */
  stage: text('stage').notNull(),
  /** Fine-grained event, e.g. 'search_completed', 'release_rejected', 'grab_sent'. */
  event_type: text('event_type').notNull(),
  /** Structured taxonomy code from reason_codes.ts - null for plain progress events. */
  reason_code: text('reason_code'),
  /** Denormalized from reason_code, kept in sync, for fast filtering/badging. */
  reason_category: text('reason_category'),
  /** Human-readable summary line for the trace UI. */
  message: text('message').notNull(),
  /** Release title this event pertains to, if any. */
  release_title: text('release_title'),
  /** Indexer name this event pertains to, if any. */
  indexer_name: text('indexer_name'),
  /** Extra structured detail (rejected release list, scores, etc.) as JSON. */
  metadata_json: text('metadata_json'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  itemIndex: index('idx_pipeline_events_item').on(
    table.show_id,
    table.season_number,
    table.episode_number,
  ),
  createdAtIndex: index('idx_pipeline_events_created_at').on(table.created_at),
  stageIndex: index('idx_pipeline_events_stage').on(table.stage),
}));

export const pipelineEventsRelations = relations(pipelineEvents, ({ one }) => ({
  show: one(shows, {
    fields: [pipelineEvents.show_id],
    references: [shows.id],
  }),
}));

// ---- System health snapshot ----
//
// Polled/cached current status of each indexer, download client, and
// import path - the second shared primitive from the pipeline design brief
// (§5), alongside pipeline_events above. Unlike pipeline_events this is a
// current-state table (upserted by component), not an append-only log -
// the brief describes it as a "snapshot," and the health dashboard (§4)
// only ever needs the latest reading per component, not history.
//
// Uses the same reason_code/category taxonomy as pipeline_events
// (core/pipeline/reason_codes.ts) so a diagnosis lookup (§3) can serve
// both tables from one place, per the brief's explicit ask not to build
// per-surface error parsers.
//
// NOTE: this table has no poller wired up yet - see docs/unified-pipeline-status.md.
export const systemHealth = sqliteTable('system_health', {
  component_type: text('component_type').notNull(), // 'indexer' | 'download_client' | 'import_path'
  component_id: text('component_id').notNull(),
  component_name: text('component_name').notNull(),
  status: text('status').notNull(), // 'healthy' | 'degraded' | 'down'
  reason_code: text('reason_code'),
  reason_category: text('reason_category'),
  message: text('message'),
  metadata_json: text('metadata_json'),
  checked_at: text('checked_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.component_type, table.component_id] }),
}));
