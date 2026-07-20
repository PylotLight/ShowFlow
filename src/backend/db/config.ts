import { eq, and, asc, desc } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';

function normalizeIndexers(v: unknown): string[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [...(Array.isArray((v as any).tv) ? (v as any).tv : []), ...(Array.isArray((v as any).anime) ? (v as any).anime : [])];
  return [];
}

// ---- Show Profiles ----

export function listShowProfiles(self: DatabaseManager): { id: string; name: string; root_folder_path: string }[] {
  return self.drizz.select().from(schema.showProfiles).orderBy(asc(schema.showProfiles.name)).all();
}

export function saveShowProfile(self: DatabaseManager, id: string, name: string, rootFolderPath: string) {
  self.drizz
    .insert(schema.showProfiles)
    .values({ id, name, root_folder_path: rootFolderPath })
    .onConflictDoUpdate({ target: schema.showProfiles.id, set: { name, root_folder_path: rootFolderPath } })
    .run();
}

export function removeShowProfile(self: DatabaseManager, id: string) {
  self.drizz.delete(schema.showProfiles).where(eq(schema.showProfiles.id, id)).run();
}

export function getShowProfileRootFolder(self: DatabaseManager, profileId: string): string | null {
  const row = self.drizz.select({ root_folder_path: schema.showProfiles.root_folder_path })
    .from(schema.showProfiles)
    .where(eq(schema.showProfiles.id, profileId))
    .get();
  return row?.root_folder_path ?? null;
}

// ---- Settings ----

export function getSetting(self: DatabaseManager, key: string) {
  const row = self.drizz.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row ? row.value : null;
}

export function setSetting(self: DatabaseManager, key: string, value: any) {
  const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
  self.drizz
    .insert(schema.settings)
    .values({ key, value: val })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: val } })
    .run();
}

export function removeSetting(self: DatabaseManager, key: string) {
  self.drizz.delete(schema.settings).where(eq(schema.settings.key, key)).run();
}

export function getAllSettings(self: DatabaseManager) {
  return self.drizz.select().from(schema.settings).all();
}

// ---- Quality ----

export function saveQuality(self: DatabaseManager, q: { id: string; name: string; rank: number; minSize?: number; maxSize?: number }) {
  const values = { id: q.id, name: q.name, rank: q.rank, min_size: q.minSize ?? null, max_size: q.maxSize ?? null };
  self.drizz
    .insert(schema.qualityDefinitions)
    .values(values)
    .onConflictDoUpdate({ target: schema.qualityDefinitions.id, set: values })
    .run();
}

export function getQuality(self: DatabaseManager, id: string) {
  return self.drizz.select().from(schema.qualityDefinitions).where(eq(schema.qualityDefinitions.id, id)).get();
}

export function removeQuality(self: DatabaseManager, id: string) {
  self.drizz.delete(schema.qualityDefinitions).where(eq(schema.qualityDefinitions.id, id)).run();
}

export function listQualities(self: DatabaseManager) {
  return self.drizz.select().from(schema.qualityDefinitions).orderBy(desc(schema.qualityDefinitions.rank)).all();
}

// ---- Quality Profiles ----

export function saveProfile(self: DatabaseManager, p: { id: string; name: string; cutoffId?: string }) {
  const values = { id: p.id, name: p.name, cutoff_quality_id: p.cutoffId ?? null };
  self.drizz
    .insert(schema.qualityProfiles)
    .values(values)
    .onConflictDoUpdate({ target: schema.qualityProfiles.id, set: values })
    .run();
}

export function resolveProfileId(self: DatabaseManager, id: string | null | undefined): string | undefined {
  if (id && getProfile(self, id)) return id;
  const profiles = listProfiles(self);
  return profiles.length > 0 ? profiles[0]!.id : undefined;
}

export function getProfile(self: DatabaseManager, id: string): any {
  return self.drizz.select().from(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, id)).get();
}

export function removeProfile(self: DatabaseManager, id: string) {
  self.drizz.delete(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, id)).run();
}

export function listProfiles(self: DatabaseManager): any[] {
  return self.drizz.select().from(schema.qualityProfiles).all();
}

// ---- Library Types ----
//
// See schema.ts's libraryTypes table comment + design-brief-platform-ux-systems.md §1.
// `indexers` is the sole source of indexer routing now that
// quality_profiles.indexers has been dropped (design-brief-quality-profile-library-type-rework.md §4).

export function listLibraryTypes(self: DatabaseManager): any[] {
  const rows = self.drizz.select().from(schema.libraryTypes).orderBy(asc(schema.libraryTypes.name)).all();
  return rows.map((row) => {
    const result: any = { ...row };
    if (result.indexers) {
      try { result.indexers = normalizeIndexers(JSON.parse(result.indexers)); } catch { result.indexers = []; }
    }
    return result;
  });
}

export function getLibraryType(self: DatabaseManager, id: string): any {
  const row = self.drizz.select().from(schema.libraryTypes).where(eq(schema.libraryTypes.id, id)).get();
  if (!row) return row;
  const result: any = { ...row };
  if (result.indexers) {
    try { result.indexers = normalizeIndexers(JSON.parse(result.indexers)); } catch { result.indexers = []; }
  }
  return result;
}

export function saveLibraryType(self: DatabaseManager, t: { id: string; name: string; rootFolderPath?: string; qualityProfileId?: string; indexers?: Record<string, string[]> | string[]; isDefault?: boolean }) {
  const values = {
    id: t.id,
    name: t.name,
    root_folder_path: t.rootFolderPath ?? null,
    quality_profile_id: t.qualityProfileId ?? null,
    indexers: JSON.stringify(t.indexers ?? []),
    is_default: t.isDefault ? 1 : 0,
  };
  self.drizz
    .insert(schema.libraryTypes)
    .values(values)
    .onConflictDoUpdate({ target: schema.libraryTypes.id, set: values })
    .run();
}

export function removeLibraryType(self: DatabaseManager, id: string) {
  self.drizz.delete(schema.libraryTypes).where(eq(schema.libraryTypes.id, id)).run();
}

/**
 * Resolves a library type id to a usable row, falling back to the
 * system's default (is_default = 1) or, failing that, the first one that
 * exists. Mirrors resolveProfileId()'s fallback shape so callers that used
 * to do `resolveProfileId(show.profile)` can switch to this without
 * reworking their null-handling.
 */
export function resolveLibraryTypeId(self: DatabaseManager, id: string | null | undefined): string | undefined {
  if (id && getLibraryType(self, id)) return id;
  const types = listLibraryTypes(self);
  const def = types.find((t) => t.is_default === 1);
  if (def) return def.id;
  return types.length > 0 ? types[0]!.id : undefined;
}

// ---- Custom Formats ----

export function saveCustomFormat(self: DatabaseManager, f: { id: string; name: string; regex: string; score: number }) {
  self.drizz
    .insert(schema.customFormats)
    .values(f)
    .onConflictDoUpdate({ target: schema.customFormats.id, set: f })
    .run();
}

export function getCustomFormat(self: DatabaseManager, id: string) {
  return self.drizz.select().from(schema.customFormats).where(eq(schema.customFormats.id, id)).get();
}

export function removeCustomFormat(self: DatabaseManager, id: string) {
  self.drizz.delete(schema.customFormats).where(eq(schema.customFormats.id, id)).run();
}

export function listCustomFormats(self: DatabaseManager) {
  return self.drizz.select().from(schema.customFormats).all();
}

// ---- Profile-Format mapping ----

export function addProfileFormat(self: DatabaseManager, profileId: string, formatId: string, type: 'bonus' | 'required' | 'forbidden' = 'bonus') {
  self.drizz
    .insert(schema.profileFormats)
    .values({ profile_id: profileId, format_id: formatId, type })
    .onConflictDoUpdate({ target: [schema.profileFormats.profile_id, schema.profileFormats.format_id], set: { type } })
    .run();
}

export function removeProfileFormat(self: DatabaseManager, profileId: string, formatId: string) {
  self.drizz
    .delete(schema.profileFormats)
    .where(and(eq(schema.profileFormats.profile_id, profileId), eq(schema.profileFormats.format_id, formatId)))
    .run();
}

export function getProfileFormats(self: DatabaseManager, profileId: string) {
  return self.drizz
    .select({
      id: schema.customFormats.id,
      name: schema.customFormats.name,
      regex: schema.customFormats.regex,
      score: schema.customFormats.score,
      profile_format_type: schema.profileFormats.type,
    })
    .from(schema.customFormats)
    .innerJoin(schema.profileFormats, eq(schema.customFormats.id, schema.profileFormats.format_id))
    .where(eq(schema.profileFormats.profile_id, profileId))
    .all();
}

// ---- Profile-Quality mapping ----

export function addProfileQuality(self: DatabaseManager, profileId: string, qualityId: string) {
  self.drizz
    .insert(schema.profileQualities)
    .values({ profile_id: profileId, quality_id: qualityId })
    .onConflictDoNothing()
    .run();
}

export function removeProfileQuality(self: DatabaseManager, profileId: string, qualityId: string) {
  self.drizz
    .delete(schema.profileQualities)
    .where(and(eq(schema.profileQualities.profile_id, profileId), eq(schema.profileQualities.quality_id, qualityId)))
    .run();
}

export function getProfileQualities(self: DatabaseManager, profileId: string) {
  return self.drizz
    .select({
      id: schema.qualityDefinitions.id,
      name: schema.qualityDefinitions.name,
      rank: schema.qualityDefinitions.rank,
      min_size: schema.qualityDefinitions.min_size,
      max_size: schema.qualityDefinitions.max_size,
    })
    .from(schema.qualityDefinitions)
    .innerJoin(schema.profileQualities, eq(schema.qualityDefinitions.id, schema.profileQualities.quality_id))
    .where(eq(schema.profileQualities.profile_id, profileId))
    .orderBy(desc(schema.qualityDefinitions.rank))
    .all();
}
