import { inArray, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

/**
 * Seed data required for a fresh database to be usable - default quality
 * definitions, a couple of bonus custom formats, and the built-in quality
 * profiles.
 *
 * Table creation itself is no longer done here - it's entirely handled by
 * Drizzle migrations (see db/index.ts, which runs them at startup). This
 * function only ever inserts rows, and every insert is idempotent
 * (onConflictDoNothing) so it's safe to call on every boot.
 */
export function seedDefaults(drizz: BunSQLiteDatabase<typeof schema>): void {
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
    drizz.insert(schema.qualityDefinitions).values(q).onConflictDoNothing().run();
  }

  const formats: { id: string; name: string; regex: string; score: number }[] = [
    { id: 'f_hdr', name: 'HDR', regex: 'HDR', score: 50 },
    { id: 'f_x265', name: 'x265', regex: 'x265', score: 10 },
    { id: 'f_hevc', name: 'HEVC', regex: 'HEVC', score: 10 },
    { id: 'f_h265', name: 'H265', regex: 'H265', score: 10 },
  ];
  for (const f of formats) {
    drizz.insert(schema.customFormats).values(f).onConflictDoNothing().run();
  }

  drizz.insert(schema.qualityProfiles).values({ id: 'standard', name: 'Standard' }).onConflictDoNothing().run();
  for (const formatId of ['f_hdr', 'f_x265', 'f_h265']) {
    drizz.insert(schema.profileFormats)
      .values({ profile_id: 'standard', format_id: formatId, type: 'bonus' })
      .onConflictDoNothing()
      .run();
  }

  drizz.insert(schema.qualityProfiles).values({ id: 'anime', name: 'Anime' }).onConflictDoNothing().run();
  for (const formatId of ['f_x265', 'f_hevc', 'f_h265']) {
    drizz.insert(schema.profileFormats)
      .values({ profile_id: 'anime', format_id: formatId, type: 'bonus' })
      .onConflictDoNothing()
      .run();
  }
}

/** Drops placeholder quality ids ('q1'..'q4') left over from a very old, pre-migration schema version. Safe no-op on any DB that never had them. */
export function migrateQualityIds(drizz: BunSQLiteDatabase<typeof schema>): void {
  drizz.delete(schema.qualityDefinitions).where(inArray(schema.qualityDefinitions.id, ['q1', 'q2', 'q3', 'q4'])).run();
}

/**
 * One-time seed for the Library Type model
 * (design-brief-platform-ux-systems.md §1). Runs on every boot but is a
 * no-op once library_types has rows, so it's safe to call unconditionally
 * like the other seed steps in this file.
 *
 * Deliberately NOT derived from whatever quality_profiles happen to exist
 * on a given install - that produced generic-but-wrong names 1:1 off
 * profile rows, which is specific to whatever profiles this particular
 * install has, not something safe to assume for every user. Instead this
 * seeds a small, fixed set of generic defaults that are broadly true across
 * installs ("Shows" and "Anime" - both are just names, fully renameable
 * via the existing saveLibraryType()/PATCH path at any time, including
 * during onboarding). No "Movies" default - this app has no movie entity
 * in the schema (shows/seasons/episodes only, Sonarr-only per
 * codebase-mapping.md), so there's nothing for a Movies type to attach to
 * yet. If movie support is ever added, that's a schema addition in its own
 * right, not a seed-data tweak here.
 *
 * What it does:
 *  1. Creates "Shows" (-> the 'standard' quality profile) as the default
 *     type, and "Anime" (-> the 'anime' quality profile) alongside it,
 *     each carrying over that profile's existing `indexers` JSON so
 *     current indexer associations aren't lost in the switch.
 *  2. Backfills `shows.library_type_id`: shows with `profile = 'anime'`
 *     get the Anime type, everything else gets Shows.
 *
 * This does NOT drop the legacy shows.profile / series_type /
 * root_folder_path columns or quality_profiles.indexers - see the schema.ts
 * comment on shows for why those stay populated in parallel for now.
 */
export function seedDefaultLibraryTypes(drizz: BunSQLiteDatabase<typeof schema>): void {
  const existingTypes = drizz.select({ id: schema.libraryTypes.id }).from(schema.libraryTypes).all();
  if (existingTypes.length > 0) return; // already seeded (and possibly renamed/edited since - never overwrite)

  const getProfile = (id: string) => drizz.select().from(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, id)).get();

  const defaults: { id: string; name: string; profileId: string; isDefault: boolean }[] = [
    { id: 'lt_shows', name: 'Shows', profileId: 'standard', isDefault: true },
    { id: 'lt_anime', name: 'Anime', profileId: 'anime', isDefault: false },
  ];

  for (const d of defaults) {
    const profile = getProfile(d.profileId);
    if (!profile) continue; // e.g. 'anime' profile was deleted on this install - skip rather than reference a non-existent profile
    drizz.insert(schema.libraryTypes).values({
      id: d.id,
      name: d.name,
      root_folder_path: null, // no per-type default folder yet - falls back to the first show_profiles entry at use-sites, same as today's behavior
      quality_profile_id: profile.id,
      indexers: (profile as any).indexers ?? '{}',
      is_default: d.isDefault ? 1 : 0,
    }).onConflictDoNothing().run();
  }

  const anyDefault = drizz.select({ id: schema.libraryTypes.id }).from(schema.libraryTypes).where(eq(schema.libraryTypes.is_default, 1)).all();
  if (anyDefault.length === 0) {
    const first = drizz.select({ id: schema.libraryTypes.id }).from(schema.libraryTypes).all()[0];
    if (first) {
      drizz.update(schema.libraryTypes).set({ is_default: 1 }).where(eq(schema.libraryTypes.id, first.id)).run();
    }
  }

  // Backfill: anime-profiled shows -> Anime type, everything else -> Shows.
  // Only meaningful if both seed rows actually landed above.
  const shownsType = drizz.select({ id: schema.libraryTypes.id }).from(schema.libraryTypes).where(eq(schema.libraryTypes.id, 'lt_shows')).get();
  const animeType = drizz.select({ id: schema.libraryTypes.id }).from(schema.libraryTypes).where(eq(schema.libraryTypes.id, 'lt_anime')).get();
  const fallbackTypeId = shownsType?.id ?? animeType?.id;
  if (!fallbackTypeId) return;

  const shows = drizz.select({ id: schema.shows.id, profile: schema.shows.profile }).from(schema.shows).all();
  for (const show of shows) {
    const targetId = show.profile === 'anime' && animeType ? animeType.id : fallbackTypeId;
    drizz.update(schema.shows).set({ library_type_id: targetId }).where(eq(schema.shows.id, show.id)).run();
  }
}
