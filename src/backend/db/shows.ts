import { eq, and, or, like, sql, asc, inArray } from 'drizzle-orm';
import * as schema from './schema';
import { extractShowTitleCandidates } from '../core/show_titles';
import type { DatabaseManager } from './index';

// ---- Title normalization ----

export function normalizeShowTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[._]+/g, ' ')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

// ---- Title queries ----

function upsertShowTitle(self: DatabaseManager, input: {
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
  const normalizedTitle = normalizeShowTitle(title);

  if (!title || !normalizedTitle) {
    return;
  }

  self.drizz
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

function syncCoreShowTitles(self: DatabaseManager, input: {
  showId: string;
  title: string;
  originalTitle?: string;
  providerType: string;
}) {
  upsertShowTitle(self, {
    showId: input.showId,
    title: input.title,
    titleType: 'canonical',
    providerType: input.providerType,
  });

  if (input.originalTitle?.trim()) {
    upsertShowTitle(self, {
      showId: input.showId,
      title: input.originalTitle,
      titleType: 'original',
      providerType: input.providerType,
    });
  }
}

export function syncAllShowTitles(
  self: DatabaseManager,
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
    upsertShowTitle(self, {
      showId,
      title,
      titleType: 'alias',
      providerType,
    });
  }
}

export function backfillShowTitles(self: DatabaseManager) {
  const rows = self.drizz
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
    upsertShowTitle(self, {
      showId: row.showId,
      title: row.showTitle,
      titleType: 'canonical',
      providerType: row.providerType,
    });

    if (row.showOriginalTitle) {
      upsertShowTitle(self, {
        showId: row.showId,
        title: row.showOriginalTitle,
        titleType: 'original',
        providerType: row.providerType,
      });
    }

    if (row.providerTitle) {
      upsertShowTitle(self, {
        showId: row.showId,
        title: row.providerTitle,
        titleType: 'provider',
        providerType: row.providerType,
      });
    }

    if (row.providerOriginalTitle) {
      upsertShowTitle(self, {
        showId: row.showId,
        title: row.providerOriginalTitle,
        titleType: 'original',
        providerType: row.providerType,
      });
    }

    if (row.providerMetadataJson) {
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = JSON.parse(row.providerMetadataJson);
      } catch {
        metadata = undefined;
      }

      if (metadata) {
        syncAllShowTitles(self, row.showId, row.providerType, { metadata });
      }
    }
  }
}

// ---- Title lookups ----

export function findShowsByNormalizedTitle(self: DatabaseManager, normalizedTitle: string) {
  return self.drizz
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

export function getLocalShowCandidates(self: DatabaseManager) {
  // The previous single query joined shows x show_providers x show_titles.
  // Every title row duplicated the full provider_metadata_json string
  // (~33x per show here), materializing hundreds of MB of identical strings
  // on the JS heap and OOM-killing the pod on the manual-import list page.
  // Split into two cheap queries and merge: metadata is loaded once per
  // show and only attached to the first row of each show+provider pair.
  const providerRows = self.drizz
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
    })
    .from(schema.shows)
    .innerJoin(
      schema.showProviders,
      eq(schema.showProviders.show_id, schema.shows.id),
    )
    .all();

  const titleRows = self.drizz
    .select({
      showId: schema.showTitles.show_id,
      knownTitle: schema.showTitles.title,
      knownTitleType: schema.showTitles.title_type,
      knownTitleLanguage: schema.showTitles.language,
    })
    .from(schema.showTitles)
    .all();

  const titlesByShow = new Map<string, {
    knownTitle: string;
    knownTitleType: string | null;
    knownTitleLanguage: string | null;
  }[]>();
  for (const title of titleRows) {
    const list = titlesByShow.get(title.showId) ?? [];
    list.push(title);
    titlesByShow.set(title.showId, list);
  }

  const rows: {
    showId: string;
    showTitle: string;
    showOriginalTitle: string | null;
    showYear: number | null;
    showSeriesType: string | null;

    providerType: string;
    providerId: string;
    providerTitle: string | null;
    providerOriginalTitle: string | null;
    providerMetadataJson: string | null;
    isPrimary: number | null;

    knownTitle: string | null;
    knownTitleType: string | null;
    knownTitleLanguage: string | null;
  }[] = [];

  for (const provider of providerRows) {
    const titles = titlesByShow.get(provider.showId) ?? [];
    if (titles.length === 0) {
      rows.push({ ...provider, knownTitle: null, knownTitleType: null, knownTitleLanguage: null });
      continue;
    }
    for (const [index, title] of titles.entries()) {
      rows.push({
        ...provider,
        providerMetadataJson: index === 0 ? provider.providerMetadataJson : null,
        knownTitle: title.knownTitle,
        knownTitleType: title.knownTitleType,
        knownTitleLanguage: title.knownTitleLanguage,
      });
    }
  }

  return rows;
}

// ---- Show CRUD ----

export function saveShow(self: DatabaseManager, show: {
  uuid: string;
  providerId: string;
  type: string;
  title: string;
  profile?: string;
  showProfileId?: string;
  libraryTypeId?: string;
  config: any;
  year?: number;
  originalTitle?: string;
  romanizedTitle?: string;
  metadata?: any;
  rootFolderPath?: string;
  seriesType?: string;
  /** Show-level "monitor new episodes". Defaults to on for new shows; left
   *  untouched on re-save of an existing show unless explicitly passed. */
  monitorNewEpisodes?: boolean;
}) {
  const resolvedLibraryTypeId = show.libraryTypeId ? self.resolveLibraryTypeId(show.libraryTypeId) : undefined;
  const profile = resolvedLibraryTypeId
    ? (self.getLibraryType(resolvedLibraryTypeId)?.quality_profile_id ?? self.resolveProfileId(show.profile) ?? show.profile ?? undefined)
    : (self.resolveProfileId(show.profile) ?? show.profile ?? undefined);
  const rootFolderPath = show.rootFolderPath ?? (show.showProfileId ? self.getShowProfileRootFolder(show.showProfileId) : null);
  const seriesType = show.seriesType ?? 'standard';

  self.drizz.insert(schema.shows).values({
    id: show.uuid,
    title: show.title,
    original_title: show.originalTitle ?? null,
    year: show.year ?? null,
    profile,
    series_type: seriesType,
    root_folder_path: rootFolderPath,
    library_type_id: resolvedLibraryTypeId ?? null,
    monitor_new_episodes: show.monitorNewEpisodes === false ? 0 : 1,
  }).onConflictDoUpdate({
    target: schema.shows.id,
    set: {
      title: show.title,
      original_title: show.originalTitle ?? null,
      year: show.year ?? null,
      profile,
      series_type: seriesType,
      root_folder_path: rootFolderPath,
      library_type_id: resolvedLibraryTypeId ?? null,
      ...(show.monitorNewEpisodes !== undefined
        ? { monitor_new_episodes: show.monitorNewEpisodes ? 1 : 0 }
        : {}),
      last_updated: sql`(datetime('now'))`,
    },
  }).run();

  const existingProvider = self.drizz.select({ pt: schema.showProviders.provider_type })
    .from(schema.showProviders)
    .where(and(
      eq(schema.showProviders.show_id, show.uuid),
      eq(schema.showProviders.provider_type, show.type),
    )).get();

  if (existingProvider) {
    self.drizz.update(schema.showProviders).set({
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
    const providerCount = self.drizz.select({ c: sql<number>`count(*)` })
      .from(schema.showProviders)
      .where(eq(schema.showProviders.show_id, show.uuid))
      .get();

    self.drizz.insert(schema.showProviders).values({
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

  syncCoreShowTitles(self, {
    showId: show.uuid,
    title: show.title,
    originalTitle: show.originalTitle,
    providerType: show.type,
  });

  syncAllShowTitles(self, show.uuid, show.type, {
    title: show.title,
    originalTitle: show.originalTitle,
    romanizedTitle: show.romanizedTitle,
    metadata: show.metadata,
  });
}

export function updateShowSyncData(self: DatabaseManager, showId: string, providerType: string, data: {
  title?: string;
  year?: number;
  originalTitle?: string;
  romanizedTitle?: string;
  metadata?: any;
}) {
  const showSet: Record<string, any> = { last_updated: sql`(datetime('now'))` };
  // A user rename wins over provider title refreshes: keep the title the user
  // chose even when the metadata provider reports its own canonical title.
  // The user-chosen title is indexed as a `user` show_title row by renameShow.
  const titleOverridden = hasUserTitleOverride(self, showId);
  if (data.title !== undefined && !titleOverridden) showSet.title = data.title;
  if (data.year !== undefined) showSet.year = data.year;
  if (data.originalTitle !== undefined) showSet.original_title = data.originalTitle;

  self.drizz.update(schema.shows).set(showSet)
    .where(eq(schema.shows.id, showId)).run();

  const providerSet: Record<string, any> = { last_synced: sql`(datetime('now'))` };
  if (data.title !== undefined) providerSet.title = data.title;
  if (data.year !== undefined) providerSet.year = data.year;
  if (data.originalTitle !== undefined) providerSet.original_title = data.originalTitle;
  if (data.metadata !== undefined) providerSet.metadata_json = JSON.stringify(data.metadata);

  self.drizz.update(schema.showProviders).set(providerSet)
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders.provider_type, providerType),
    )).run();

  if (data.title) {
    syncCoreShowTitles(self, {
      showId,
      title: data.title,
      originalTitle: data.originalTitle,
      providerType,
    });
  } else if (data.originalTitle) {
    upsertShowTitle(self, {
      showId,
      title: data.originalTitle,
      titleType: 'original',
      providerType,
    });
  }

  if (data.title || data.originalTitle || data.romanizedTitle || data.metadata) {
    syncAllShowTitles(self, showId, providerType, {
      title: data.title,
      originalTitle: data.originalTitle,
      romanizedTitle: data.romanizedTitle,
      metadata: data.metadata,
    });
  }
}

export function getShow(self: DatabaseManager, showId: string) {
  const row = self.drizz.select().from(schema.shows)
    .where(eq(schema.shows.id, showId)).get();

  if (!row) return null as any;

  const primaryProvider = self.drizz.select().from(schema.showProviders)
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

export function getShowConfig(self: DatabaseManager, showId: string): Record<string, any> {
  const show = getShow(self, showId);
  if (!show) return {};
  const config: Record<string, any> = {
    seriesType: show.series_type ?? 'standard',
  };
  const providers = self.drizz.select().from(schema.showProviders)
    .where(eq(schema.showProviders.show_id, showId)).all() as any[];
  for (const p of providers) {
    if (p.is_metadata) config.metadataProvider = p.provider_type;
    if (p.is_airtime) config.airtimeProvider = p.provider_type;
  }
  const mapping = self.getEpisodeMappingConfig(showId);
  config.episodeMapping = {
    enabled: mapping.enabled === 1,
    source: mapping.source,
    health: mapping.health,
    lastSynced: mapping.last_synced,
    lastError: mapping.last_error,
    healthDetail: mapping.health_detail ? safeJsonDetail(mapping.health_detail) : [],
  };
  return config;
}

function safeJsonDetail(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return [json];
  }
  return [];
}

export function getProviderForRole(self: DatabaseManager, showId: string, role: 'metadata' | 'airtime'): {
  providerType: string;
  providerId: string;
} | null {
  const flag = role === 'metadata' ? 'is_metadata' : 'is_airtime';
  const provider = self.drizz.select().from(schema.showProviders)
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders[flag as 'is_metadata'], 1),
    )).get();

  if (provider) {
    return { providerType: provider.provider_type, providerId: provider.provider_id };
  }

  const primary = self.drizz.select().from(schema.showProviders)
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders.is_primary, 1),
    )).get();
  if (primary) {
    return { providerType: primary.provider_type, providerId: primary.provider_id };
  }

  return null;
}

export function setProviderRole(self: DatabaseManager, showId: string, providerType: string, role: 'metadata' | 'airtime', active: boolean): void {
  const flag = role === 'metadata' ? 'is_metadata' : 'is_airtime';

  self.drizz.update(schema.showProviders).set({ [flag]: 0 })
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders[flag as 'is_metadata'], 1),
    )).run();

  if (active) {
    self.drizz.update(schema.showProviders).set({ [flag]: 1 })
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).run();
  }
}

export function listShowProvidersWithRoles(self: DatabaseManager, showId: string): any[] {
  const providers = self.drizz.select().from(schema.showProviders)
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

export function getShowByName(self: DatabaseManager, name: string) {
  const rows = self.drizz.select().from(schema.shows)
    .where(like(schema.shows.title, `%${name}%`))
    .all();

  return rows.map(row => {
    const primaryProvider = self.drizz.select().from(schema.showProviders)
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

export function listShows(self: DatabaseManager) {
  const rows = self.drizz.select().from(schema.shows).all();

  const showIds = rows.map(r => r.id);
  const providers = showIds.length > 0
    ? self.drizz.select().from(schema.showProviders)
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

export interface ShowSummaryRow {
  id: string;
  title: string;
  year: number | null;
  profile: string | null;
  series_type: string | null;
  root_folder_path: string | null;
  added_at: string | null;
  last_updated: string | null;
  provider_type: string | null;
  tracked_count: number;
  grabbed_count: number;
  monitor_new_episodes: number;
}

/**
 * Library grid rows for GET /api/shows: show columns + primary provider type
 * + per-show tracked/on-disk counts in ONE query. Replaces listShows() +
 * pulling every episode row into JS to count them (and dragging each show's
 * provider metadata_json blob along for a field the route never sent).
 */
export function listShowSummaries(self: DatabaseManager): ShowSummaryRow[] {
  return self.db.query(`
    SELECT
      s.id, s.title, s.year, s.profile, s.series_type, s.root_folder_path,
      s.added_at, s.last_updated, s.monitor_new_episodes,
      (SELECT sp.provider_type FROM show_providers sp
        WHERE sp.show_id = s.id AND sp.is_primary = 1 LIMIT 1) AS provider_type,
      COALESCE(st.tracked_count, 0) AS tracked_count,
      COALESCE(st.grabbed_count, 0) AS grabbed_count
    FROM shows s
    LEFT JOIN (
      SELECT show_id,
        SUM(CASE WHEN is_tracked = 1 THEN 1 ELSE 0 END) AS tracked_count,
        SUM(CASE WHEN file_path IS NOT NULL AND file_path != '' THEN 1 ELSE 0 END) AS grabbed_count
      FROM episodes
      GROUP BY show_id
    ) st ON st.show_id = s.id
    ORDER BY s.rowid
  `).all() as ShowSummaryRow[];
}

export function countShows(self: DatabaseManager): number {
  const row = self.db.query('SELECT count(*) AS c FROM shows').get() as { c: number } | null;
  return row?.c ?? 0;
}

export function hasUpcomingEpisodes(self: DatabaseManager, showId: string) {
  const row = self.drizz.select({ one: sql<number>`1` })
    .from(schema.episodes)
    .where(and(
      eq(schema.episodes.show_id, showId),
      or(
        sql`air_date > datetime('now')`,
        // Tracked episodes with no known air date still need frequent
        // metadata refreshes — the date may appear at any time. Without
        // this a show whose next episode is TBA falls back to the 30-day
        // maintenance cadence and its date never gets picked up.
        sql`air_date IS NULL`,
        sql`air_date = ''`,
      ),
    ))
    .limit(1)
    .get();
  return !!row;
}

export function getShowByProvider(self: DatabaseManager, providerType: string, providerId: string) {
  const providerRow = self.drizz.select().from(schema.showProviders)
    .where(and(
      eq(schema.showProviders.provider_type, providerType),
      eq(schema.showProviders.provider_id, providerId),
    )).get();

  if (!providerRow) return null as any;

  const show = self.drizz.select().from(schema.shows)
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

export function addShowProvider(self: DatabaseManager, showId: string, providerType: string, providerId: string, data?: {
  title?: string;
  originalTitle?: string;
  year?: number;
  metadata?: any;
  isPrimary?: boolean;
}): void {
  const existing = self.drizz.select({ pt: schema.showProviders.provider_type })
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

    self.drizz.update(schema.showProviders).set(setData)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.provider_type, providerType),
      )).run();
  } else {
    const providerCount = self.drizz.select({ c: sql<number>`count(*)` })
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

    self.drizz.insert(schema.showProviders).values(values as any).run();
  }
}

export function removeShowProvider(self: DatabaseManager, showId: string, providerType: string): void {
  const count = self.drizz.select({ c: sql<number>`count(*)` })
    .from(schema.showProviders)
    .where(eq(schema.showProviders.show_id, showId))
    .get();

  if (!count || count.c <= 1) {
    throw new Error('Cannot remove the last provider from a show');
  }

  self.drizz.delete(schema.showProviders)
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders.provider_type, providerType),
    )).run();
}

export function setPrimaryProvider(self: DatabaseManager, showId: string, providerType: string): void {
  self.drizz.update(schema.showProviders).set({ is_primary: 0 })
    .where(eq(schema.showProviders.show_id, showId)).run();

  self.drizz.update(schema.showProviders).set({ is_primary: 1 })
    .where(and(
      eq(schema.showProviders.show_id, showId),
      eq(schema.showProviders.provider_type, providerType),
    )).run();
}

export function listShowProviders(self: DatabaseManager, showId: string): any[] {
  return self.drizz.select().from(schema.showProviders)
    .where(eq(schema.showProviders.show_id, showId))
    .all() as any[];
}

// ---- Seasons ----

export function saveSeason(self: DatabaseManager, showId: string, seasonNumber: number, title?: string) {
  self.drizz.insert(schema.seasons).values({
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

export function getSeason(self: DatabaseManager, showId: string, seasonNumber: number) {
  return self.drizz.select().from(schema.seasons)
    .where(and(
      eq(schema.seasons.show_id, showId),
      eq(schema.seasons.season_number, seasonNumber),
    )).get() as any;
}

export function listSeasons(self: DatabaseManager, showId: string) {
  return self.drizz.select().from(schema.seasons)
    .where(eq(schema.seasons.show_id, showId))
    .orderBy(asc(schema.seasons.season_number))
    .all() as any[];
}

// ---- Episodes ----

/**
 * How far back a *newly inserted* episode's air date may be and still get
 * auto-tracked on a metadata refresh. Shows without known upcoming episodes
 * only re-sync every ~30 days (sync_manager), so an episode announced and
 * aired between two syncs can already be a few weeks old when we first see
 * it. Older rows appearing out of nowhere are almost always back-catalog
 * churn (provider switch / renumbering), which we don't want to grab.
 */
export const NEW_EPISODE_LOOKBACK_DAYS = 30;

export interface AutoTrackContext {
  /** shows.monitor_new_episodes */
  monitor: boolean;
  /** Show already tracks at least one season-0 episode. */
  tracksSpecials: boolean;
  /** Show had no episode rows before this write (first sync after add):
   *  only upcoming/TBA episodes count as "new" then, not the whole back
   *  catalog. */
  initialPopulation: boolean;
  now?: Date;
}

/**
 * Should a brand-new episode row be inserted with is_tracked = 1?
 *   - show must have monitor_new_episodes on
 *   - specials (season 0) only when the show already tracks some specials
 *   - TBA (no air date) -> yes
 *   - first population of a show -> air date today or later
 *   - later refreshes -> air date within NEW_EPISODE_LOOKBACK_DAYS or later
 */
export function shouldAutoTrackNewEpisode(
  ep: { seasonNumber: number; airDate?: string | null },
  ctx: AutoTrackContext,
): boolean {
  if (!ctx.monitor) return false;
  if (ep.seasonNumber === 0 && !ctx.tracksSpecials) return false;
  const air = ep.airDate?.trim();
  if (!air) return true;
  const now = ctx.now ?? new Date();
  const cutoff = new Date(now.getTime() - (ctx.initialPopulation ? 0 : NEW_EPISODE_LOOKBACK_DAYS) * 86_400_000);
  return air.slice(0, 10) >= cutoff.toISOString().slice(0, 10);
}

function loadAutoTrackContext(self: DatabaseManager, showId: string, existing?: any[]): AutoTrackContext {
  const show = self.drizz.select({ m: schema.shows.monitor_new_episodes })
    .from(schema.shows).where(eq(schema.shows.id, showId)).get();
  const rows = existing ?? (self.drizz.select({
    season_number: schema.episodes.season_number,
    is_tracked: schema.episodes.is_tracked,
  }).from(schema.episodes).where(eq(schema.episodes.show_id, showId)).all() as any[]);
  return {
    monitor: (show?.m ?? 0) === 1,
    tracksSpecials: rows.some(r => r.season_number === 0 && r.is_tracked === 1),
    initialPopulation: rows.length === 0,
  };
}

export function saveEpisode(self: DatabaseManager, episode: {
  showId: string;
  seasonNumber: number;
  episodeNumber: number;
  absoluteNumber?: number;
  title?: string;
  filePath?: string;
  airDate?: string;
  airTime?: string;
  /** Apply the show's monitor-new-episodes rule if this call creates the
   *  row. Opt-in: the blackhole import path sets it so an episode first seen
   *  via an imported file is tracked like a synced one; Sonarr import and
   *  other callers manage is_tracked themselves. */
  autoTrackNew?: boolean;
}) {
  // Providers use "" for "no date announced yet" — normalize to NULL so
  // date queries (IS NOT NULL / range comparisons) treat it as unscheduled
  // instead of a value that silently matches neither.
  //
  // Preserve previously-known values when the caller passes nothing for a
  // field: the import path (blackhole) calls this with only the file info,
  // and blindly overwriting air_date with NULL wiped good airtimes from a
  // prior metadata sync every time an episode was (re)imported. Clearing
  // file_path goes through updateEpisodeFilePath, never here, so preserving
  // on absent is safe for all fields.
  const prev = self.drizz.select().from(schema.episodes).where(and(
    eq(schema.episodes.show_id, episode.showId),
    eq(schema.episodes.season_number, episode.seasonNumber),
    eq(schema.episodes.episode_number, episode.episodeNumber),
  )).get() as any | undefined;
  const airDate = episode.airDate?.trim() ? episode.airDate : (prev?.air_date ?? null);
  const airTime = episode.airTime?.trim() ? episode.airTime : (prev?.air_time ?? null);
  const title = episode.title?.trim() ? episode.title : (prev?.title ?? '');
  const absoluteNumber = episode.absoluteNumber ?? prev?.absolute_number ?? 0;
  const filePath = episode.filePath?.trim() ? episode.filePath : (prev?.file_path ?? '');
  // is_tracked only matters on a true insert - onConflictDoUpdate below never
  // touches it, so existing rows keep whatever tracking they had.
  const autoTrack = !prev && episode.autoTrackNew === true
    && shouldAutoTrackNewEpisode(
      { seasonNumber: episode.seasonNumber, airDate },
      { ...loadAutoTrackContext(self, episode.showId), initialPopulation: false },
    );
  self.drizz.insert(schema.episodes).values({
    show_id: episode.showId,
    season_number: episode.seasonNumber,
    episode_number: episode.episodeNumber,
    absolute_number: absoluteNumber,
    title,
    file_path: filePath,
    air_date: airDate,
    air_time: airTime,
    is_tracked: autoTrack ? 1 : 0,
  }).onConflictDoUpdate({
    target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
    set: {
      title,
      absolute_number: absoluteNumber,
      file_path: filePath,
      air_date: airDate,
      air_time: airTime,
      last_updated: sql`(datetime('now'))`,
    },
  }).run();
}

export function syncEpisodes(self: DatabaseManager, showId: string, episodes: {
  seasonNumber: number;
  episodeNumber: number;
  absoluteNumber?: number;
  title?: string;
  airDate?: string;
  airTime?: string;
}[]) {
  // Preserve previously-known values when the provider returns nothing for
  // a field. Providers routinely return null/"" air dates for TBA episodes
  // (or drop air times TMDB never had); blindly overwriting with NULL wipes
  // the good date from a prior sync and the episode vanishes from the
  // calendar/dashboard (which filter on air_date IS NOT NULL).
  const existing = self.drizz.select().from(schema.episodes)
    .where(eq(schema.episodes.show_id, showId)).all() as any[];
  const existingByKey = new Map(existing.map(e => [`${e.season_number}:${e.episode_number}`, e]));
  // Show-level monitor-new-episodes: decided once per sync from the rows that
  // existed *before* it, so a batch of fresh inserts can't bootstrap itself
  // (e.g. a new tracked special enabling more specials).
  const trackCtx = loadAutoTrackContext(self, showId, existing);

  const transaction = self.db.transaction((eps: typeof episodes) => {
    for (const ep of eps) {
      const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
      const prev = existingByKey.get(key);
      const incomingAirDate = ep.airDate?.trim() ? ep.airDate : null;
      const incomingAirTime = ep.airTime?.trim() ? ep.airTime : null;
      // Only consulted for brand-new rows; the conflict path never writes
      // is_tracked so existing tracking is left exactly as the user set it.
      const autoTrack = !prev && shouldAutoTrackNewEpisode(
        { seasonNumber: ep.seasonNumber, airDate: incomingAirDate },
        trackCtx,
      );
      self.drizz.insert(schema.episodes).values({
        show_id: showId,
        season_number: ep.seasonNumber,
        episode_number: ep.episodeNumber,
        absolute_number: ep.absoluteNumber ?? prev?.absolute_number ?? 0,
        title: ep.title?.trim() ? ep.title : (prev?.title ?? ''),
        air_date: incomingAirDate ?? prev?.air_date ?? null,
        air_time: incomingAirTime ?? prev?.air_time ?? null,
        is_tracked: autoTrack ? 1 : 0,
      }).onConflictDoUpdate({
        target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
        set: {
          title: ep.title?.trim() ? ep.title : (prev?.title ?? ''),
          absolute_number: ep.absoluteNumber ?? prev?.absolute_number ?? 0,
          air_date: incomingAirDate ?? prev?.air_date ?? null,
          air_time: incomingAirTime ?? prev?.air_time ?? null,
          last_updated: sql`(datetime('now'))`,
        },
      }).run();
    }
  });
  transaction(episodes);
}

export function getEpisode(self: DatabaseManager, showId: string, seasonNumber: number, episodeNumber: number) {
  return self.drizz.select().from(schema.episodes)
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
      eq(schema.episodes.episode_number, episodeNumber),
    )).get() as any;
}

export function listEpisodes(self: DatabaseManager, showId: string, seasonNumber: number) {
  return self.drizz.select().from(schema.episodes)
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
    ))
    .orderBy(asc(schema.episodes.season_number), asc(schema.episodes.episode_number))
    .all() as any[];
}

export function listAllEpisodes(self: DatabaseManager, showId: string) {
  return self.drizz.select().from(schema.episodes)
    .where(eq(schema.episodes.show_id, showId))
    .orderBy(asc(schema.episodes.season_number), asc(schema.episodes.episode_number))
    .all() as any[];
}

export function listUpcomingEpisodes(self: DatabaseManager, futureDays: number, pastDays = 0) {
  const start = new Date(Date.now() - pastDays * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000).toISOString();

  const result = self.drizz.select({
    episode: schema.episodes,
    show_title: schema.shows.title,
  })
    .from(schema.episodes)
    .leftJoin(schema.shows, eq(schema.episodes.show_id, schema.shows.id))
    .where(and(
      eq(schema.episodes.is_tracked, 1),
      sql`${schema.episodes.air_date} IS NOT NULL`,
      sql`${schema.episodes.air_date} != ''`,
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
 * Tracked episodes with no known air date (NULL or provider ""), which the
 * date-windowed calendar/missing queries exclude. Surfaced separately so
 * shows whose next episode is TBA don't silently disappear from the
 * dashboard — they render under a "Date TBA" group instead.
 */
export function listUnscheduledEpisodes(self: DatabaseManager) {
  const result = self.drizz.select({
    episode: schema.episodes,
    show_title: schema.shows.title,
  })
    .from(schema.episodes)
    .leftJoin(schema.shows, eq(schema.episodes.show_id, schema.shows.id))
    .where(and(
      eq(schema.episodes.is_tracked, 1),
      or(
        sql`${schema.episodes.air_date} IS NULL`,
        sql`${schema.episodes.air_date} = ''`,
      ),
    ))
    .orderBy(asc(schema.episodes.show_id), asc(schema.episodes.season_number), asc(schema.episodes.episode_number))
    .all();

  return result.map(r => ({
    ...r.episode,
    show_title: r.show_title,
  })) as any[];
}

export function listMissingEpisodes(self: DatabaseManager) {
  const result = self.drizz.select({
    episode: schema.episodes,
    show_title: schema.shows.title,
  })
    .from(schema.episodes)
    .leftJoin(schema.shows, eq(schema.episodes.show_id, schema.shows.id))
    .where(and(
      eq(schema.episodes.is_tracked, 1),
      sql`${schema.episodes.air_date} IS NOT NULL`,
      sql`${schema.episodes.air_date} != ''`,
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

export function setTracked(self: DatabaseManager, showId: string, seasonNumber: number, episodeNumber: number, tracked: boolean) {
  self.drizz.update(schema.episodes).set({ is_tracked: tracked ? 1 : 0 })
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
      eq(schema.episodes.episode_number, episodeNumber),
    )).run();
}

export function updateEpisodeFilePath(self: DatabaseManager, showId: string, seasonNumber: number, episodeNumber: number, filePath: string) {
  self.drizz.update(schema.episodes).set({ file_path: filePath })
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
      eq(schema.episodes.episode_number, episodeNumber),
    )).run();
}

export function listShowEpisodes(self: DatabaseManager, showId: string): {
  season_number: number;
  episode_number: number;
  file_path: string | null;
}[] {
  return self.drizz.select({
    season_number: schema.episodes.season_number,
    episode_number: schema.episodes.episode_number,
    file_path: schema.episodes.file_path,
  }).from(schema.episodes)
    .where(eq(schema.episodes.show_id, showId))
    .all() as any;
}

export function updateEpisodeSearchMode(self: DatabaseManager, showId: string, seasonNumber: number, episodeNumber: number, mode: string) {
  self.drizz.update(schema.episodes).set({ search_mode: mode })
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
      eq(schema.episodes.episode_number, episodeNumber),
    )).run();
}

/** Persist the air-window forecast (air time + expected release time). */
export function updateEpisodeAirWindow(self: DatabaseManager, showId: string, seasonNumber: number, episodeNumber: number, updates: {
  airTime?: string | null;
  expectedReleaseAt?: string | null;
}) {
  const setData: Record<string, any> = { last_updated: sql`(datetime('now'))` };
  if (updates.airTime !== undefined) setData.air_time = updates.airTime;
  if (updates.expectedReleaseAt !== undefined) setData.expected_release_at = updates.expectedReleaseAt;
  self.drizz.update(schema.episodes).set(setData)
    .where(and(
      eq(schema.episodes.show_id, showId),
      eq(schema.episodes.season_number, seasonNumber),
      eq(schema.episodes.episode_number, episodeNumber),
    )).run();
}

/** Store the show's learned release delay (minutes after air). */
export function setShowReleaseDelay(self: DatabaseManager, showId: string, delayMinutes: number) {
  self.drizz.update(schema.shows).set({ release_delay_minutes: delayMinutes, last_updated: sql`(datetime('now'))` })
    .where(eq(schema.shows.id, showId)).run();
}

export function getShowRootFolder(self: DatabaseManager, showId: string): string | null {
  const row = self.drizz.select({ root_folder_path: schema.shows.root_folder_path })
    .from(schema.shows)
    .where(eq(schema.shows.id, showId))
    .get();
  return row?.root_folder_path || null;
}

export function updateShow(self: DatabaseManager, showId: string, updates: Partial<{
  title: string;
  profile: string;
  seriesType: string;
  config: Record<string, any>;
  rootFolderPath: string;
  libraryTypeId: string;
  monitorNewEpisodes: boolean;
  /** One-shot: also track already-known episodes that haven't aired yet
   *  (air_date today or later, or TBA). Specials follow the same rule as
   *  auto-tracking. */
  trackUpcoming: boolean;
}>) {
  const setData: Record<string, any> = { last_updated: sql`(datetime('now'))` };
  if (updates.monitorNewEpisodes !== undefined) setData.monitor_new_episodes = updates.monitorNewEpisodes ? 1 : 0;
  if (updates.trackUpcoming) trackUpcomingEpisodes(self, showId);
  if (updates.title !== undefined) setData.title = updates.title;
  if (updates.profile !== undefined) setData.profile = updates.profile;
  if (updates.seriesType !== undefined) setData.series_type = updates.seriesType;
  if (updates.config?.seriesType !== undefined) setData.series_type = updates.config.seriesType;
  if (updates.rootFolderPath !== undefined) setData.root_folder_path = updates.rootFolderPath;

  // Episode-mapping config (anime season-splits, issues-tracking.md #4).
  // `config.episodeMapping.enabled` flips the per-show toggle; when a show
  // is switched to 'anime' series type and no override row exists yet, the
  // default-on fallback (enabled = seriesType === 'anime') kicks in.
  const mappingCfg = updates.config?.episodeMapping as
    | { enabled?: boolean | number; source?: string }
    | undefined;
  if (mappingCfg && (mappingCfg.enabled !== undefined || mappingCfg.source !== undefined)) {
    self.setEpisodeMappingConfig(showId, {
      enabled: mappingCfg.enabled !== undefined ? mappingCfg.enabled : undefined,
      source: mappingCfg.source,
    });
  }

  // Banner backdrop selection (detail-page cycler). Per-show setting, no
  // schema migration needed; the images route clamps it against the live
  // option list on read.
  if (updates.config?.backdropIndex !== undefined) {
    const n = Math.floor(Number(updates.config.backdropIndex));
    self.setSetting(`backdropIndex.${showId}`, String(Number.isFinite(n) && n > 0 ? n : 0));
  }

  // Banner focal point (top/center/bottom crop anchor). Same settings
  // backing as the backdrop pick.
  if (updates.config?.backdropPosition !== undefined) {
    self.setSetting(`backdropPosition.${showId}`, normalizeBackdropPosition(updates.config.backdropPosition));
  }

  // Apply a library type: bundles root folder + quality profile + indexers
  // (design-brief-platform-ux-systems.md §1). Resolves the identifier the
  // same way saveShow does so a bare id/name or the default type all land on
  // the same show.
  if (updates.libraryTypeId !== undefined) {
    const resolvedId = self.resolveLibraryTypeId(updates.libraryTypeId);
    const libraryType = resolvedId ? self.getLibraryType(resolvedId) : null;
    setData.library_type_id = resolvedId ?? null;
    if (libraryType) {
      if (libraryType.quality_profile_id) setData.profile = libraryType.quality_profile_id;
      if (libraryType.root_folder_path) setData.root_folder_path = libraryType.root_folder_path;
    }
  }

  self.drizz.update(schema.shows).set(setData)
    .where(eq(schema.shows.id, showId)).run();
}

/** Track every existing, not-yet-aired (or TBA) episode of a show. Returns rows changed. */
export function trackUpcomingEpisodes(self: DatabaseManager, showId: string, now = new Date()): number {
  const rows = self.drizz.select().from(schema.episodes)
    .where(eq(schema.episodes.show_id, showId)).all() as any[];
  const tracksSpecials = rows.some(r => r.season_number === 0 && r.is_tracked === 1);
  const ctx: AutoTrackContext = { monitor: true, tracksSpecials, initialPopulation: true, now };
  let changed = 0;
  for (const r of rows) {
    if (r.is_tracked === 1) continue;
    if (!shouldAutoTrackNewEpisode({ seasonNumber: r.season_number, airDate: r.air_date }, ctx)) continue;
    setTracked(self, showId, r.season_number, r.episode_number, true);
    changed++;
  }
  return changed;
}

export function setShowTracking(self: DatabaseManager, showId: string, tracked: boolean) {
  self.drizz.update(schema.episodes).set({ is_tracked: tracked ? 1 : 0 })
    .where(eq(schema.episodes.show_id, showId)).run();
}

/** Valid banner focal points; anything else falls back to 'top'. */
export type BackdropPosition = 'top' | 'center' | 'bottom';

export function normalizeBackdropPosition(value: unknown): BackdropPosition {
  return value === 'center' || value === 'bottom' ? value : 'top';
}

/** Selected banner focal point for a show. Defaults to 'top' (title art survives the 21:7 crop). */
export function getShowBackdropPosition(self: DatabaseManager, showId: string): BackdropPosition {
  return normalizeBackdropPosition(self.getSetting(`backdropPosition.${showId}`));
}

/** Selected banner backdrop index for a show (detail-page cycler). Defaults to 0. */
export function getShowBackdropIndex(self: DatabaseManager, showId: string): number {
  const raw = self.getSetting(`backdropIndex.${showId}`);
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Math.floor(Number(raw));
  return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : 0;
}

/** Backdrop option URLs, persisted whenever the provider list is fetched so
 *  the image endpoint can resolve an index to a URL (and its cached bytes)
 *  without a network round-trip on every request. */
export interface StoredBackdropOption { url: string; width?: number; height?: number; thumb?: string }

export function getShowBackdropOptions(self: DatabaseManager, showId: string): StoredBackdropOption[] {
  try {
    const raw = self.getSetting(`backdropOptions.${showId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((o): o is StoredBackdropOption =>
        !!o && typeof (o as StoredBackdropOption).url === 'string')
      .slice(0, 32);
  } catch {
    return [];
  }
}

export function saveShowBackdropOptions(self: DatabaseManager, showId: string, options: StoredBackdropOption[]): void {
  try {
    self.setSetting(`backdropOptions.${showId}`, JSON.stringify(options.slice(0, 32)));
    self.setSetting(`backdropOptionsAt.${showId}`, String(Date.now()));
  } catch {
    // Persistence is best-effort; a miss just costs one provider round-trip.
  }
}

/** When the persisted backdrop option list was last refreshed (epoch ms, 0 if never). */
export function getShowBackdropOptionsAt(self: DatabaseManager, showId: string): number {
  const raw = self.getSetting(`backdropOptionsAt.${showId}`);
  const n = raw == null ? NaN : parseInt(String(raw), 10);
  return Number.isFinite(n) ? (n as number) : 0;
}

/** True when a user has renamed the show (a `user`-typed show_title row exists). */
export function hasUserTitleOverride(self: DatabaseManager, showId: string): boolean {
  const row = self.drizz.select({ id: schema.showTitles.id })
    .from(schema.showTitles)
    .where(and(
      eq(schema.showTitles.show_id, showId),
      eq(schema.showTitles.title_type, 'user'),
    ))
    .get();
  return !!row;
}

/**
 * Rename a show to a user-chosen title. Updates shows.title and records the
 * new title as a `user` show_title row so (a) the new name resolves on the
 * normalized show_titles index and (b) provider metadata syncs stop clobbering
 * the rename (updateShowSyncData checks hasUserTitleOverride). The old title's
 * existing canonical/alias rows are left in place so files on disk that still
 * use the old name keep matching.
 */
export function renameShow(self: DatabaseManager, showId: string, newTitle: string) {
  const title = newTitle.trim();
  if (!title) return { renamed: false, reason: 'empty-title' };

  const current = getShow(self, showId);
  if (!current) return { renamed: false, reason: 'not-found' };
  // Compare raw (trimmed) titles, not normalized ones: two spellings can
  // normalize identically yet the user still wants the on-disk title/folder
  // renamed (e.g. "Re: ZERO..." → "Re - ZERO..." to match what Sonarr or a
  // manual edit produced on disk).
  if (title === current.title) {
    return { renamed: false, reason: 'unchanged' };
  }

  self.drizz.update(schema.shows)
    .set({ title, last_updated: sql`(datetime('now'))` })
    .where(eq(schema.shows.id, showId))
    .run();

  upsertShowTitle(self, {
    showId,
    title,
    titleType: 'user',
    providerType: 'local',
  });

  return { renamed: true, oldTitle: current.title, newTitle: title };
}


export function bulkUpdateShows(self: DatabaseManager, ids: string[], updates: Partial<{
  profile: string;
  seriesType: string;
  libraryTypeId: string;
  tracked: boolean;
}>) {
  const affected: string[] = [];
  for (const id of ids) {
    if (!getShow(self, id)) continue;
    updateShow(self, id, {
      profile: updates.profile,
      seriesType: updates.seriesType,
      libraryTypeId: updates.libraryTypeId,
    });
    if (updates.tracked !== undefined) setShowTracking(self, id, updates.tracked);
    affected.push(id);
  }
  return affected;
}

export function removeShow(self: DatabaseManager, showId: string) {
  self.drizz.delete(schema.shows)
    .where(eq(schema.shows.id, showId)).run();
}

export function removeShows(self: DatabaseManager, ids: string[]) {
  if (ids.length === 0) return;
  self.drizz.delete(schema.shows)
    .where(inArray(schema.shows.id, ids)).run();
}

// ---- Show Artworks ----

export function saveShowArtwork(self: DatabaseManager, showId: string, type: number, imageUrl: string, width?: number, height?: number, thumbnail?: string, data?: Uint8Array, contentType?: string, providerType?: string) {
  if (!providerType) {
    const primaryProvider = self.drizz.select({ pt: schema.showProviders.provider_type })
      .from(schema.showProviders)
      .where(and(
        eq(schema.showProviders.show_id, showId),
        eq(schema.showProviders.is_primary, 1),
      )).get();
    providerType = primaryProvider?.pt || 'unknown';
  }

  const artworkType = String(type);

  const existing = self.drizz.select({ id: schema.showArtworks.id })
    .from(schema.showArtworks)
    .where(and(
      eq(schema.showArtworks.show_id, showId),
      eq(schema.showArtworks.provider_type, providerType),
      eq(schema.showArtworks.artwork_type, artworkType),
    )).get();

  if (existing) {
    self.drizz.update(schema.showArtworks).set({
      image_url: imageUrl,
      width: width ?? null,
      height: height ?? null,
      thumbnail: thumbnail ?? null,
      content_type: contentType ?? null,
      data: data ?? null,
    }).where(eq(schema.showArtworks.id, existing.id)).run();
  } else {
    self.drizz.insert(schema.showArtworks).values({
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

export function getShowArtworks(self: DatabaseManager, showId: string, type?: number, providerType?: string) {
  const conditions = [eq(schema.showArtworks.show_id, showId)];
  if (type !== undefined) conditions.push(eq(schema.showArtworks.artwork_type, String(type)));
  if (providerType !== undefined) conditions.push(eq(schema.showArtworks.provider_type, providerType));

  return self.drizz.select().from(schema.showArtworks)
    .where(and(...conditions))
    .orderBy(asc(schema.showArtworks.artwork_type))
    .all() as any[];
}

/** show_artworks row without its image bytes (see getShowArtworkMeta). */
export interface ShowArtworkMeta {
  id: number;
  show_id: string;
  provider_type: string;
  artwork_type: string;
  image_url: string;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  content_type: string | null;
  /** Byte length of the stored image, 0 when no bytes are cached. */
  data_len: number;
}

/**
 * Same rows as getShowArtworks minus the `data` blob. Image routes pick the
 * one row they need from this, then load only that blob via
 * getShowArtworkBlob — instead of reading every cached poster/backdrop/thumb
 * blob for the show on every request. length(data) is answered from the
 * record header, so the blobs themselves aren't read here.
 */
export function getShowArtworkMeta(self: DatabaseManager, showId: string, type?: number): ShowArtworkMeta[] {
  const typeClause = type !== undefined ? 'AND artwork_type = ?' : '';
  const params: (string)[] = type !== undefined ? [showId, String(type)] : [showId];
  return self.db.query(`
    SELECT id, show_id, provider_type, artwork_type, image_url, width, height,
           thumbnail, content_type, COALESCE(length(data), 0) AS data_len
    FROM show_artworks
    WHERE show_id = ? ${typeClause}
    ORDER BY artwork_type ASC
  `).all(...params) as ShowArtworkMeta[];
}

/** The image bytes for one show_artworks row. */
export function getShowArtworkBlob(self: DatabaseManager, id: number): Uint8Array | null {
  const row = self.db.query('SELECT data FROM show_artworks WHERE id = ?').get(id) as { data: Uint8Array | null } | null;
  return row?.data ?? null;
}

export function updateShowArtworkData(self: DatabaseManager, showId: string, type: number, data: Uint8Array, providerType?: string) {
  const conditions = [
    eq(schema.showArtworks.show_id, showId),
    eq(schema.showArtworks.artwork_type, String(type)),
  ];
  if (providerType !== undefined) conditions.push(eq(schema.showArtworks.provider_type, providerType));

  self.drizz.update(schema.showArtworks).set({ data })
    .where(and(...conditions)).run();
}
