import { inArray } from 'drizzle-orm';
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
