import { inArray } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import seedManifest from './seed/manifest.json';

/**
 * Shape of db/seed/manifest.json - the single source of truth for default
 * qualities, custom formats, and quality profiles seeded into a fresh
 * database. Keep this in sync with that file; TS only checks shape here,
 * not IDs referenced across sections (e.g. a profile's `bonusFormats`
 * entry that doesn't match any `customFormats.id` is caught at runtime in
 * seedDefaults(), not at compile time.
 *
 * Library types are NOT seeded here (deliberately, since
 * design-brief-quality-profile-library-type-rework.md's decision to have
 * onboarding be the sole creator of library_types rows) - see
 * OnboardingWizard's Library step, which POSTs to /api/library-types
 * directly once a user picks root folders + types.
 */
interface SeedManifest {
  qualities: { id: string; name: string; rank: number }[];
  customFormats: { id: string; name: string; regex: string; score: number }[];
  qualityProfiles: { id: string; name: string; bonusFormats: string[]; allowedQualities?: string[] }[];
}

const manifest = seedManifest as SeedManifest;

/**
 * Seed data required for a fresh database to be usable - default quality
 * definitions, a couple of bonus custom formats, and the built-in quality
 * profiles. All of the actual data lives in db/seed/manifest.json - this
 * function is just the (idempotent) loop that inserts it.
 *
 * Table creation itself is no longer done here - it's entirely handled by
 * Drizzle migrations (see db/index.ts, which runs them at startup). This
 * function only ever inserts rows, and every insert is idempotent
 * (onConflictDoNothing) so it's safe to call on every boot.
 */
export function seedDefaults(drizz: BunSQLiteDatabase<typeof schema>): void {
  for (const q of manifest.qualities) {
    drizz.insert(schema.qualityDefinitions).values(q).onConflictDoNothing().run();
  }

  for (const f of manifest.customFormats) {
    drizz.insert(schema.customFormats).values(f).onConflictDoNothing().run();
  }

  for (const profile of manifest.qualityProfiles) {
    drizz.insert(schema.qualityProfiles).values({ id: profile.id, name: profile.name }).onConflictDoNothing().run();
    for (const formatId of profile.bonusFormats) {
      drizz.insert(schema.profileFormats)
        .values({ profile_id: profile.id, format_id: formatId, type: 'bonus' })
        .onConflictDoNothing()
        .run();
    }
    for (const qualityId of profile.allowedQualities ?? []) {
      drizz.insert(schema.profileQualities)
        .values({ profile_id: profile.id, quality_id: qualityId })
        .onConflictDoNothing()
        .run();
    }
  }
}

/** Drops placeholder quality ids ('q1'..'q4') left over from a very old, pre-migration schema version. Safe no-op on any DB that never had them. */
export function migrateQualityIds(drizz: BunSQLiteDatabase<typeof schema>): void {
  drizz.delete(schema.qualityDefinitions).where(inArray(schema.qualityDefinitions.id, ['q1', 'q2', 'q3', 'q4'])).run();
}
