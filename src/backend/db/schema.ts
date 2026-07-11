import { sqliteTable, text, integer, primaryKey, uniqueIndex, blob } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

export const shows = sqliteTable('shows', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  original_title: text('original_title'),
  year: integer('year'),
  profile: text('profile').default('standard'),
  config_json: text('config_json'),
  root_folder_path: text('root_folder_path'),
  sort_title: text('sort_title'),
  added_at: text('added_at').default(sql`(datetime('now'))`),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
});

export const showProviders = sqliteTable('show_providers', {
  show_id: text('show_id').notNull().references(() => shows.id, { onDelete: 'cascade' }),
  provider_type: text('provider_type').notNull(),
  provider_id: text('provider_id').notNull(),
  title: text('title'),
  original_title: text('original_title'),
  year: integer('year'),
  metadata_json: text('metadata_json'),
  is_primary: integer('is_primary').default(0),
  last_synced: text('last_synced'),
}, (table) => ({
  pk: primaryKey({ columns: [table.show_id, table.provider_type] }),
  uniqueProvider: uniqueIndex('uq_show_providers_provider').on(table.provider_type, table.provider_id),
}));

export const seasons = sqliteTable('seasons', {
  show_id: text('show_id').notNull().references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number').notNull(),
  title: text('title'),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
}, (table) => ({
  pk: primaryKey({ columns: [table.show_id, table.season_number] }),
}));

export const episodes = sqliteTable('episodes', {
  show_id: text('show_id').notNull().references(() => shows.id, { onDelete: 'cascade' }),
  season_number: integer('season_number').notNull(),
  episode_number: integer('episode_number').notNull(),
  absolute_number: integer('absolute_number'),
  title: text('title'),
  file_path: text('file_path'),
  is_tracked: integer('is_tracked').default(0),
  air_date: text('air_date'),
  search_mode: text('search_mode').default('auto'),
  last_updated: text('last_updated').default(sql`(datetime('now'))`),
}, (table) => ({
  pk: primaryKey({ columns: [table.show_id, table.season_number, table.episode_number] }),
}));

export const showArtworks = sqliteTable('show_artworks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  show_id: text('show_id').notNull().references(() => shows.id, { onDelete: 'cascade' }),
  provider_type: text('provider_type').notNull(),
  artwork_type: text('artwork_type').notNull(),
  image_url: text('image_url').notNull(),
  width: integer('width'),
  height: integer('height'),
  thumbnail: text('thumbnail'),
  content_type: text('content_type'),
  data: blob('data'),
}, (table) => ({
  uniqueArtwork: uniqueIndex('uq_show_artworks').on(table.show_id, table.provider_type, table.artwork_type),
}));

export const showsRelations = relations(shows, ({ many }) => ({
  providers: many(showProviders),
  seasons: many(seasons),
  episodes: many(episodes),
  artworks: many(showArtworks),
}));

export const showProvidersRelations = relations(showProviders, ({ one }) => ({
  show: one(shows, {
    fields: [showProviders.show_id],
    references: [shows.id],
  }),
}));

export const seasonsRelations = relations(seasons, ({ one }) => ({
  show: one(shows, {
    fields: [seasons.show_id],
    references: [shows.id],
  }),
}));
