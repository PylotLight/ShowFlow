/**
 * Read/write the streamlined quality profile model (quality_profiles new
 * columns + profile_terms + custom_terms), and the one-time conversion of
 * legacy profiles (model_version 0) into it.
 *
 * The legacy tables (quality_definitions allow-lists, custom_formats,
 * profile_formats, cutoff_quality_id) are left untouched and read-only for
 * one release so the migration preview can score old vs new.
 */
import { eq } from 'drizzle-orm';
import type { DatabaseManager } from './index';
import * as schema from './schema';
import {
  BUILTIN_TERMS, CUSTOM_PREFIX, TERM_MODES, getBuiltinTerm, isCustomTermId, isReleaseSource,
  type ResolvedTerm, type TermMode, type ReleaseSource,
} from '../core/quality_terms';
import { convertLegacyProfile, type LegacyFormat } from '../core/quality_migration';

export const MODEL_VERSION = 2;

export interface ProfileTermRow {
  termId: string;
  mode: TermMode;
  weight: number | null;
}

export interface ProfileModel {
  id: string;
  name: string;
  modelVersion: number;
  minResolution: number | null;
  targetResolution: number | null;
  allowUnknownResolution: boolean;
  skipSources: ReleaseSource[];
  upgradesEnabled: boolean;
  upgradeUntilResolution: number | null;
  upgradeUntilSource: ReleaseSource | null;
  upgradeUntilScore: number | null;
  terms: ProfileTermRow[];
  migrationNote: string | null;
}

function parseSkip(raw: unknown): ReleaseSource[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isReleaseSource) : [];
  } catch { return []; }
}

function legacyInputs(dbm: DatabaseManager, profileId: string, row: any) {
  const formats: LegacyFormat[] = dbm.getProfileFormats(profileId).map((f: any) => ({
    id: f.id, name: f.name, regex: f.regex, score: f.score ?? 0, type: f.profile_format_type ?? 'bonus',
  }));
  const allowed = dbm.getProfileQualities(profileId).map((q: any) => ({ id: q.id, name: q.name, rank: q.rank }));
  const cutoffQ = row.cutoff_quality_id ? dbm.getQuality(row.cutoff_quality_id) : null;
  return { formats, allowed, cutoff: cutoffQ ? { name: cutoffQ.name as string } : null };
}

function rowToModel(dbm: DatabaseManager, row: any): ProfileModel {
  if ((row.model_version ?? 0) < MODEL_VERSION) {
    // Not converted yet (fresh legacy row, e.g. a test or a profile saved
    // through the old API): convert in memory, don't write.
    const c = convertLegacyProfile(legacyInputs(dbm, row.id, row));
    return {
      id: row.id, name: row.name, modelVersion: row.model_version ?? 0,
      minResolution: c.minResolution, targetResolution: c.targetResolution,
      allowUnknownResolution: c.allowUnknownResolution, skipSources: c.skipSources,
      upgradesEnabled: c.upgradesEnabled, upgradeUntilResolution: c.upgradeUntilResolution,
      upgradeUntilSource: c.upgradeUntilSource, upgradeUntilScore: null,
      terms: c.terms.map(t => ({ termId: t.termId, mode: t.mode, weight: t.weight })),
      migrationNote: c.notes.length ? c.notes.join('\n') : null,
    };
  }
  const terms = dbm.drizz.select().from(schema.profileTerms).where(eq(schema.profileTerms.profile_id, row.id)).all()
    .filter(t => (TERM_MODES as string[]).includes(t.mode))
    .map(t => ({ termId: t.term_id, mode: t.mode as TermMode, weight: t.weight ?? null }));
  return {
    id: row.id,
    name: row.name,
    modelVersion: row.model_version,
    minResolution: row.min_resolution ?? null,
    targetResolution: row.target_resolution ?? null,
    allowUnknownResolution: !!row.allow_unknown_resolution,
    skipSources: parseSkip(row.skip_sources),
    upgradesEnabled: !!row.upgrades_enabled,
    upgradeUntilResolution: row.upgrade_until_resolution ?? null,
    upgradeUntilSource: isReleaseSource(row.upgrade_until_source) ? row.upgrade_until_source : null,
    upgradeUntilScore: row.upgrade_until_score ?? null,
    terms,
    migrationNote: row.migration_note ?? null,
  };
}

export function getProfileModel(dbm: DatabaseManager, profileId: string): ProfileModel | null {
  if (!profileId) return null;
  const row = dbm.drizz.select().from(schema.qualityProfiles).where(eq(schema.qualityProfiles.id, profileId)).get();
  return row ? rowToModel(dbm, row) : null;
}

export function listProfileModels(dbm: DatabaseManager): ProfileModel[] {
  return dbm.drizz.select().from(schema.qualityProfiles).all().map(r => rowToModel(dbm, r));
}

/** Custom term id -> row. */
export function listCustomTerms(dbm: DatabaseManager): { id: string; name: string; regex: string }[] {
  return dbm.drizz.select().from(schema.customTerms).all();
}

export function saveCustomTerm(dbm: DatabaseManager, t: { id: string; name: string; regex: string }) {
  new RegExp(t.regex, 'i'); // throws on an invalid pattern -> 400 at the route
  dbm.drizz.insert(schema.customTerms).values(t)
    .onConflictDoUpdate({ target: schema.customTerms.id, set: { name: t.name, regex: t.regex } }).run();
}

export function removeCustomTerm(dbm: DatabaseManager, id: string) {
  dbm.drizz.delete(schema.profileTerms).where(eq(schema.profileTerms.term_id, `${CUSTOM_PREFIX}${id}`)).run();
  dbm.drizz.delete(schema.customTerms).where(eq(schema.customTerms.id, id)).run();
}

/** A profile's terms with labels/regex filled in, ready for scoring. Unknown ids are skipped. */
export function resolveProfileTerms(dbm: DatabaseManager, model: Pick<ProfileModel, 'terms'>, customById?: Map<string, { name: string; regex: string }>): ResolvedTerm[] {
  const customs = customById ?? new Map(listCustomTerms(dbm).map(c => [c.id, c]));
  const out: ResolvedTerm[] = [];
  for (const t of model.terms) {
    if (isCustomTermId(t.termId)) {
      const c = customs.get(t.termId.slice(CUSTOM_PREFIX.length));
      if (!c) continue;
      out.push({ termId: t.termId, label: c.name, group: 'custom', mode: t.mode, weight: t.weight, regex: c.regex });
    } else {
      const b = getBuiltinTerm(t.termId);
      if (!b) continue;
      out.push({ termId: t.termId, label: b.label, group: b.group, mode: t.mode, weight: t.weight, regex: null });
    }
  }
  return out;
}

export interface ProfileModelInput {
  id: string;
  name: string;
  minResolution?: number | null;
  targetResolution?: number | null;
  allowUnknownResolution?: boolean;
  skipSources?: string[];
  upgradesEnabled?: boolean;
  upgradeUntilResolution?: number | null;
  upgradeUntilSource?: string | null;
  upgradeUntilScore?: number | null;
  terms?: { termId: string; mode: string; weight?: number | null }[];
}

function intOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Validate + write a whole profile (and optionally replace its terms). Marks it model v2. */
export function saveProfileModel(dbm: DatabaseManager, input: ProfileModelInput): ProfileModel {
  if (!input.id || !input.name?.trim()) throw new Error('id and name are required');
  const existing = getProfileModel(dbm, input.id);
  const min = input.minResolution !== undefined ? intOrNull(input.minResolution) : existing?.minResolution ?? null;
  const target = input.targetResolution !== undefined ? intOrNull(input.targetResolution) : existing?.targetResolution ?? null;
  if (min != null && target != null && min > target) throw new Error('minimum resolution is above the target');
  const skip = input.skipSources !== undefined ? input.skipSources.filter(isReleaseSource) : existing?.skipSources ?? [];
  const untilSrc = input.upgradeUntilSource !== undefined
    ? (isReleaseSource(input.upgradeUntilSource) ? input.upgradeUntilSource : null)
    : existing?.upgradeUntilSource ?? null;
  const values = {
    id: input.id,
    name: input.name.trim(),
    model_version: MODEL_VERSION,
    min_resolution: min,
    target_resolution: target,
    allow_unknown_resolution: (input.allowUnknownResolution ?? existing?.allowUnknownResolution ?? true) ? 1 : 0,
    skip_sources: JSON.stringify([...new Set(skip)]),
    upgrades_enabled: (input.upgradesEnabled ?? existing?.upgradesEnabled ?? false) ? 1 : 0,
    upgrade_until_resolution: input.upgradeUntilResolution !== undefined ? intOrNull(input.upgradeUntilResolution) : existing?.upgradeUntilResolution ?? null,
    upgrade_until_source: untilSrc,
    upgrade_until_score: input.upgradeUntilScore !== undefined ? intOrNull(input.upgradeUntilScore) : existing?.upgradeUntilScore ?? null,
  };
  const terms = input.terms ?? existing?.terms ?? [];
  dbm.db.transaction(() => {
    dbm.drizz.insert(schema.qualityProfiles).values(values)
      .onConflictDoUpdate({ target: schema.qualityProfiles.id, set: values }).run();
    writeTerms(dbm, input.id, terms);
  })();
  return getProfileModel(dbm, input.id)!;
}

function writeTerms(dbm: DatabaseManager, profileId: string, terms: { termId: string; mode: string; weight?: number | null }[]) {
  dbm.drizz.delete(schema.profileTerms).where(eq(schema.profileTerms.profile_id, profileId)).run();
  const seen = new Set<string>();
  for (const t of terms) {
    if (!t?.termId || seen.has(t.termId)) continue;
    if (!(TERM_MODES as string[]).includes(t.mode)) throw new Error(`bad mode "${t.mode}" for ${t.termId}`);
    if (!isCustomTermId(t.termId) && !getBuiltinTerm(t.termId)) throw new Error(`unknown term "${t.termId}"`);
    seen.add(t.termId);
    const weight = t.mode === 'must' || t.mode === 'never' ? null : intOrNull(t.weight);
    dbm.drizz.insert(schema.profileTerms).values({ profile_id: profileId, term_id: t.termId, mode: t.mode, weight }).run();
  }
}

export function clearMigrationNote(dbm: DatabaseManager, profileId: string) {
  dbm.drizz.update(schema.qualityProfiles).set({ migration_note: null }).where(eq(schema.qualityProfiles.id, profileId)).run();
}

export interface ConversionSummary { profileId: string; name: string; notes: string[]; terms: number }

/**
 * One-time: convert every legacy (model v0) profile into the streamlined
 * model and persist it. Idempotent - converted profiles are v2 and skipped.
 * Runs at boot right after the Drizzle migration + seed.
 */
export function convertLegacyProfiles(dbm: DatabaseManager): ConversionSummary[] {
  const rows = dbm.drizz.select().from(schema.qualityProfiles).all().filter(r => (r.model_version ?? 0) < MODEL_VERSION);
  const out: ConversionSummary[] = [];
  for (const row of rows) {
    const c = convertLegacyProfile(legacyInputs(dbm, row.id, row));
    dbm.db.transaction(() => {
      for (const t of c.terms) {
        if (t.custom) dbm.drizz.insert(schema.customTerms).values(t.custom).onConflictDoNothing().run();
      }
      dbm.drizz.update(schema.qualityProfiles).set({
        model_version: MODEL_VERSION,
        min_resolution: c.minResolution,
        target_resolution: c.targetResolution,
        allow_unknown_resolution: c.allowUnknownResolution ? 1 : 0,
        skip_sources: JSON.stringify(c.skipSources),
        upgrades_enabled: c.upgradesEnabled ? 1 : 0,
        upgrade_until_resolution: c.upgradeUntilResolution,
        upgrade_until_source: c.upgradeUntilSource,
        upgrade_until_score: null,
        migration_note: c.notes.length ? c.notes.join('\n') : null,
      }).where(eq(schema.qualityProfiles.id, row.id)).run();
      writeTerms(dbm, row.id, c.terms);
    })();
    out.push({ profileId: row.id, name: row.name, notes: c.notes, terms: c.terms.length });
  }
  return out;
}

/** Which library types use each profile, with their show counts ("used by: Anime (41 shows)"). */
export function profileUsage(dbm: DatabaseManager): Record<string, { libraryTypeId: string; name: string; shows: number }[]> {
  const rows = dbm.db.query(`
    SELECT lt.id AS id, lt.name AS name, lt.quality_profile_id AS profile_id,
           (SELECT count(*) FROM shows s WHERE s.library_type_id = lt.id) AS shows
    FROM library_types lt WHERE lt.quality_profile_id IS NOT NULL
    ORDER BY lt.name`).all() as { id: string; name: string; profile_id: string; shows: number }[];
  const out: Record<string, { libraryTypeId: string; name: string; shows: number }[]> = {};
  for (const r of rows) (out[r.profile_id] ??= []).push({ libraryTypeId: r.id, name: r.name, shows: r.shows });
  return out;
}

/** Built-in library for the UI. */
export function termLibrary() {
  return BUILTIN_TERMS.map(t => ({ id: t.id, group: t.group, label: t.label }));
}
