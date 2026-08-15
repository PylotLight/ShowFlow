import { eq, and, like, sql, asc, inArray } from 'drizzle-orm';
import * as schema from './schema';
import { extractShowTitleCandidates } from '../core/show_titles';
import type { DatabaseManager } from './index';

// ---- Title normalization ----

function normalizeShowTitle(title: string): string {
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
  if (data.title !== undefined) showSet.title = data.title;
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
  return config;
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

export function hasUpcomingEpisodes(self: DatabaseManager, showId: string) {
  const row = self.drizz.select({ one: sql<number>`1` })
    .from(schema.episodes)
    .where(and(
      eq(schema.episodes.show_id, showId),
      sql`air_date > datetime('now')`,
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

export function saveEpisode(self: DatabaseManager, episode: {
  showId: string;
  seasonNumber: number;
  episodeNumber: number;
  absoluteNumber?: number;
  title?: string;
  filePath?: string;
  airDate?: string;
  airTime?: string;
}) {
  self.drizz.insert(schema.episodes).values({
    show_id: episode.showId,
    season_number: episode.seasonNumber,
    episode_number: episode.episodeNumber,
    absolute_number: episode.absoluteNumber ?? 0,
    title: episode.title ?? '',
    file_path: episode.filePath ?? '',
    air_date: episode.airDate ?? null,
  }).onConflictDoUpdate({
    target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
    set: {
      title: episode.title ?? '',
      absolute_number: episode.absoluteNumber ?? 0,
      file_path: episode.filePath ?? '',
      air_date: episode.airDate ?? null,
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
  const transaction = self.db.transaction((eps: typeof episodes) => {
    for (const ep of eps) {
      self.drizz.insert(schema.episodes).values({
        show_id: showId,
        season_number: ep.seasonNumber,
        episode_number: ep.episodeNumber,
        absolute_number: ep.absoluteNumber ?? 0,
        title: ep.title ?? '',
        air_date: ep.airDate ?? null,
        air_time: ep.airTime ?? null,
      }).onConflictDoUpdate({
        target: [schema.episodes.show_id, schema.episodes.season_number, schema.episodes.episode_number],
        set: {
          title: ep.title ?? '',
          absolute_number: ep.absoluteNumber ?? 0,
          air_date: ep.airDate ?? null,
          air_time: ep.airTime ?? null,
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
}>) {
  const setData: Record<string, any> = { last_updated: sql`(datetime('now'))` };
  if (updates.title !== undefined) setData.title = updates.title;
  if (updates.profile !== undefined) setData.profile = updates.profile;
  if (updates.seriesType !== undefined) setData.series_type = updates.seriesType;
  if (updates.config?.seriesType !== undefined) setData.series_type = updates.config.seriesType;
  if (updates.rootFolderPath !== undefined) setData.root_folder_path = updates.rootFolderPath;

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

export function setShowTracking(self: DatabaseManager, showId: string, tracked: boolean) {
  self.drizz.update(schema.episodes).set({ is_tracked: tracked ? 1 : 0 })
    .where(eq(schema.episodes.show_id, showId)).run();
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

export function updateShowArtworkData(self: DatabaseManager, showId: string, type: number, data: Uint8Array, providerType?: string) {
  const conditions = [
    eq(schema.showArtworks.show_id, showId),
    eq(schema.showArtworks.artwork_type, String(type)),
  ];
  if (providerType !== undefined) conditions.push(eq(schema.showArtworks.provider_type, providerType));

  self.drizz.update(schema.showArtworks).set({ data })
    .where(and(...conditions)).run();
}
