import { eq, and, desc, lt, gte, sql } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';
import { describeReasonCode, type ReasonCode, type PipelineStage } from '../core/pipeline/reason_codes';

export interface LogPipelineEventInput {
  showId: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  stage: PipelineStage;
  eventType: string;
  message: string;
  reasonCode?: ReasonCode;
  releaseTitle?: string;
  indexerName?: string;
  metadata?: any;
}

export function logPipelineEvent(self: DatabaseManager, event: LogPipelineEventInput) {
  const reasonCategory = event.reasonCode ? describeReasonCode(event.reasonCode)?.category ?? null : null;

  return self.drizz
    .insert(schema.pipelineEvents)
    .values({
      show_id: event.showId,
      season_number: event.seasonNumber ?? null,
      episode_number: event.episodeNumber ?? null,
      stage: event.stage,
      event_type: event.eventType,
      reason_code: event.reasonCode ?? null,
      reason_category: reasonCategory,
      message: event.message,
      release_title: event.releaseTitle ?? null,
      indexer_name: event.indexerName ?? null,
      metadata_json: event.metadata !== undefined ? JSON.stringify(event.metadata) : null,
      // Set explicitly rather than relying on the column's `datetime('now')`
      // default - that produces "YYYY-MM-DD HH:MM:SS" (space-separated),
      // while every range query below compares against `.toISOString()`
      // ("...T...Z"). Mixing the two formats breaks same-day comparisons
      // because the separator sorts differently than the deciding digit
      // does. Writing ISO here keeps every row's format consistent with
      // what queries below actually compare against.
      created_at: new Date().toISOString(),
    })
    .run();
}

export interface PipelineEventFilter {
  showId: string;
  seasonNumber?: number;
  episodeNumber?: number;
  limit?: number;
}

/**
 * Full chronological trace for one item (§2 "why isn't this downloading
 * yet"). Ordered oldest -> newest, matching the trace UI's top-to-bottom
 * reading order.
 */
export function listPipelineEvents(self: DatabaseManager, filter: PipelineEventFilter) {
  const conditions = [eq(schema.pipelineEvents.show_id, filter.showId)];
  if (filter.seasonNumber !== undefined) conditions.push(eq(schema.pipelineEvents.season_number, filter.seasonNumber));
  if (filter.episodeNumber !== undefined) conditions.push(eq(schema.pipelineEvents.episode_number, filter.episodeNumber));

  return self.drizz
    .select()
    .from(schema.pipelineEvents)
    .where(and(...conditions))
    .orderBy(schema.pipelineEvents.created_at, schema.pipelineEvents.id)
    .limit(filter.limit ?? 200)
    .all();
}

/** Most recent event for an item - cheap way to derive "current stage" for the Kanban view without scanning full history. */
export function getLatestPipelineEvent(self: DatabaseManager, showId: string, seasonNumber?: number, episodeNumber?: number) {
  const conditions = [eq(schema.pipelineEvents.show_id, showId)];
  if (seasonNumber !== undefined) conditions.push(eq(schema.pipelineEvents.season_number, seasonNumber));
  if (episodeNumber !== undefined) conditions.push(eq(schema.pipelineEvents.episode_number, episodeNumber));

  return self.drizz
    .select()
    .from(schema.pipelineEvents)
    .where(and(...conditions))
    .orderBy(desc(schema.pipelineEvents.created_at), desc(schema.pipelineEvents.id))
    .limit(1)
    .get();
}

/** Recent events across all items, e.g. for a system-wide activity feed. */
export function listRecentPipelineEvents(self: DatabaseManager, limit = 50) {
  return self.drizz
    .select()
    .from(schema.pipelineEvents)
    .orderBy(desc(schema.pipelineEvents.created_at), desc(schema.pipelineEvents.id))
    .limit(limit)
    .all();
}

/**
 * All tracked episodes with their latest pipeline stage — powers the
 * Kanban view (§1). Uses a window-function subquery to grab the most
 * recent event per (show, season, episode) in a single scan. Episodes
 * with no pipeline event at all resolve to WANTED; episodes that already
 * have a file on disk resolve to AVAILABLE regardless of event history
 * (covers legacy imports from before pipeline tracking existed).
 */
export interface KanbanEpisode {
  showId: string;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDate: string | null;
  filePath: string | null;
  currentStage: string;
  eventId: number | null;
  eventType: string | null;
  reasonCode: string | null;
  reasonCategory: string | null;
  message: string | null;
  releaseTitle: string | null;
  eventCreatedAt: string | null;
  searchMode: string;
}

export interface KanbanLane {
  stage: string;
  label: string;
  items: KanbanEpisode[];
}

export function listKanbanEpisodes(self: DatabaseManager): KanbanEpisode[] {
  const rows = self.db.query(`
    SELECT
      e.show_id,
      e.season_number,
      e.episode_number,
      e.title              AS episode_title,
      e.air_date,
      e.expected_release_at,
      e.file_path,
      e.search_mode,
      s.title              AS show_title,
      pe.id                AS event_id,
      pe.stage             AS current_stage,
      pe.event_type,
      pe.reason_code,
      pe.reason_category,
      pe.message,
      pe.release_title,
      pe.created_at        AS event_created_at
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    LEFT JOIN (
      SELECT
        show_id, season_number, episode_number,
        id, stage, event_type, reason_code, reason_category,
        message, release_title, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY show_id, season_number, episode_number
          ORDER BY created_at DESC, id DESC
        ) AS rn
      FROM pipeline_events
    ) pe ON pe.show_id         = e.show_id
        AND pe.season_number    = e.season_number
        AND pe.episode_number   = e.episode_number
        AND pe.rn               = 1
    WHERE e.is_tracked = 1
    ORDER BY s.title ASC, e.season_number ASC, e.episode_number ASC
  `).all() as any[];

  const now = Date.now();
  const seasonKey = (showId: string, season: number) => `${showId}::${season}`;

  // A season "has started" once any of its episodes has aired (past air date)
  // or exists on disk. Seasons that haven't started (whole upcoming season is
  // "TBA" with no air dates yet, e.g. a not-yet-premiered S2) have nothing to
  // grab, so their tracked episodes must not surface as WANTED.
  const startedSeasons = new Set<string>();
  for (const r of rows) {
    const aired = r.air_date !== null && new Date(r.air_date).getTime() <= now;
    const onDisk = r.file_path !== null && r.file_path !== '';
    if (aired || onDisk) {
      startedSeasons.add(seasonKey(r.show_id, r.season_number));
    }
  }

  return rows.map(r => {
    const hasFile = r.file_path !== null && r.file_path !== '';
    const isFuture = r.air_date !== null && new Date(r.air_date) > new Date();
    const airDateKnown = r.air_date !== null && r.air_date !== '' && !isNaN(new Date(r.air_date).getTime());
    const hasExpectedRelease = r.expected_release_at !== null && r.expected_release_at !== '';

    if (hasFile) {
      return {
        showId: r.show_id,
        showTitle: r.show_title,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        episodeTitle: r.episode_title ?? null,
        airDate: r.air_date ?? null,
        filePath: r.file_path ?? null,
        currentStage: 'AVAILABLE',
        eventId: r.event_id ?? null,
        eventType: r.event_type ?? null,
        reasonCode: r.reason_code ?? null,
        reasonCategory: r.reason_category ?? null,
        message: r.message ?? null,
        releaseTitle: r.release_title ?? null,
        eventCreatedAt: r.event_created_at ?? null,
        searchMode: r.search_mode ?? 'auto',
      };
    }

    const stage = r.current_stage ?? 'WANTED';

    // A dateless ("TBA") episode with no release forecast is unsearchable -
    // the auto-grabber's due-for-grab query requires a date - so it must not
    // count as WANTED either, even mid-season.
    if (stage === 'WANTED' && (isFuture || (!airDateKnown && !hasExpectedRelease) || !startedSeasons.has(seasonKey(r.show_id, r.season_number)))) {
      return null;
    }

    return {
      showId: r.show_id,
      showTitle: r.show_title,
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
      episodeTitle: r.episode_title ?? null,
      airDate: r.air_date ?? null,
      filePath: r.file_path ?? null,
      currentStage: stage,
      eventId: r.event_id ?? null,
      eventType: r.event_type ?? null,
      reasonCode: r.reason_code ?? null,
      reasonCategory: r.reason_category ?? null,
      message: r.message ?? null,
      releaseTitle: r.release_title ?? null,
      eventCreatedAt: r.event_created_at ?? null,
      searchMode: r.search_mode ?? 'auto',
    };
  }).filter((e): e is NonNullable<typeof e> => e !== null);
}

/** Retention: pipeline_events is high-volume (every search can write several rows), so this needs to run on a schedule same as cleanupOldLogs. */
export function cleanupOldPipelineEvents(self: DatabaseManager, beforeDate: string) {
  const result = self.drizz
    .delete(schema.pipelineEvents)
    .where(lt(schema.pipelineEvents.created_at, beforeDate))
    .run() as unknown as { changes: number };
  return result;
}

export interface PipelineEventStats {
  total: number;
  last24h: number;
  last7d: number;
  byStage: { stage: string; count: number }[];
  byCategory: { category: string; count: number }[];
  byEventType: { eventType: string; count: number }[];
  oldestEventAt: string | null;
}

/** Powers the DB usage/analytics settings page - counts and breakdowns for the pipeline event log specifically, since it's the highest-volume table by far. */
export function getPipelineEventStats(self: DatabaseManager): PipelineEventStats {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const total = self.drizz.select({ c: sql<number>`count(*)` }).from(schema.pipelineEvents).get()?.c ?? 0;
  const last24h = self.drizz.select({ c: sql<number>`count(*)` })
    .from(schema.pipelineEvents)
    .where(gte(schema.pipelineEvents.created_at, dayAgo))
    .get()?.c ?? 0;
  const last7d = self.drizz.select({ c: sql<number>`count(*)` })
    .from(schema.pipelineEvents)
    .where(gte(schema.pipelineEvents.created_at, weekAgo))
    .get()?.c ?? 0;

  const byStage = self.drizz
    .select({ stage: schema.pipelineEvents.stage, count: sql<number>`count(*)` })
    .from(schema.pipelineEvents)
    .groupBy(schema.pipelineEvents.stage)
    .all();

  const byCategoryRaw = self.drizz
    .select({ category: schema.pipelineEvents.reason_category, count: sql<number>`count(*)` })
    .from(schema.pipelineEvents)
    .groupBy(schema.pipelineEvents.reason_category)
    .all();

  const byEventType = self.drizz
    .select({ eventType: schema.pipelineEvents.event_type, count: sql<number>`count(*)` })
    .from(schema.pipelineEvents)
    .groupBy(schema.pipelineEvents.event_type)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
    .all();

  const oldest = self.drizz
    .select({ created_at: schema.pipelineEvents.created_at })
    .from(schema.pipelineEvents)
    .orderBy(schema.pipelineEvents.created_at)
    .limit(1)
    .get();

  return {
    total,
    last24h,
    last7d,
    byStage,
    byCategory: byCategoryRaw.map(c => ({ category: c.category ?? 'none', count: c.count })),
    byEventType,
    oldestEventAt: oldest?.created_at ?? null,
  };
}

export interface HourlyBucket {
  hour: string;
  count: number;
}

/** Powers the activity sparkline on the analytics page. */
export function getHourlyPipelineEventCounts(self: DatabaseManager, hours = 24): HourlyBucket[] {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return self.drizz
    .select({
      hour: sql<string>`strftime('%Y-%m-%dT%H:00', ${schema.pipelineEvents.created_at})`,
      count: sql<number>`count(*)`,
    })
    .from(schema.pipelineEvents)
    .where(gte(schema.pipelineEvents.created_at, since))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all();
}

export interface NoisyShow {
  showId: string;
  showTitle: string;
  count: number;
}

/** Which shows are generating the most pipeline activity - usually a sign of something stuck in a retry loop (indexer down, bad release repeatedly rejected, etc.) rather than just "a popular show." */
export function getNoisiestShows(self: DatabaseManager, limit = 5): NoisyShow[] {
  return self.drizz
    .select({
      showId: schema.pipelineEvents.show_id,
      showTitle: schema.shows.title,
      count: sql<number>`count(*)`,
    })
    .from(schema.pipelineEvents)
    .innerJoin(schema.shows, eq(schema.pipelineEvents.show_id, schema.shows.id))
    .groupBy(schema.pipelineEvents.show_id)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)
    .all();
}

// ---- Unified history (Sonarr-style Activity/History) ----------------------
//
// One chronological feed across the three append-mostly sources that answer
// "what did the app actually do": grabs sent to a download client
// (grabbed_releases), files imported into the library (episode_files), and
// the pipeline event trail in between (searches, rejections, failures).
// Powers GET /api/history and the History page.

export interface HistoryFilter {
  limit?: number;
  offset?: number;
  showId?: string;
  /** 'grab' = sent to download client, 'import' = landed in library, 'event' = pipeline trail. */
  kind?: 'grab' | 'import' | 'event';
  /** Free-text match against show title, message, and release title. */
  query?: string;
}

export interface HistoryItem {
  id: string;
  kind: 'grab' | 'import' | 'event';
  timestamp: string;
  showId: string | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  stage: string | null;
  eventType: string | null;
  message: string;
  releaseTitle: string | null;
  indexerName: string | null;
}

export function listHistory(self: DatabaseManager, filter: HistoryFilter): { items: HistoryItem[]; hasMore: boolean } {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const kinds: ('grab' | 'import' | 'event')[] =
    filter.kind ? [filter.kind] : ['grab', 'import', 'event'];

  const selects: string[] = [];
  const params: any[] = [];

  if (kinds.includes('event')) {
    selects.push(`
      SELECT
        ('event:' || pe.id) AS id,
        'event' AS kind,
        replace(pe.created_at, ' ', 'T') AS ts,
        pe.show_id AS show_id,
        s.title AS show_title,
        pe.season_number AS season_number,
        pe.episode_number AS episode_number,
        pe.stage AS stage,
        pe.event_type AS event_type,
        pe.message AS message,
        pe.release_title AS release_title,
        pe.indexer_name AS indexer_name
      FROM pipeline_events pe
      LEFT JOIN shows s ON s.id = pe.show_id
    `);
  }
  if (kinds.includes('grab')) {
    selects.push(`
      SELECT
        ('grab:' || g.id) AS id,
        'grab' AS kind,
        replace(g.grabbed_at, ' ', 'T') AS ts,
        g.show_id AS show_id,
        s.title AS show_title,
        g.season_number AS season_number,
        g.episode_number AS episode_number,
        'GRABBED' AS stage,
        'grab_sent' AS event_type,
        COALESCE('Grabbed "' || g.release_title || '"', 'Grab recorded') AS message,
        g.release_title AS release_title,
        g.indexer_name AS indexer_name
      FROM grabbed_releases g
      LEFT JOIN shows s ON s.id = g.show_id
    `);
  }
  if (kinds.includes('import')) {
    selects.push(`
      SELECT
        ('import:' || f.id) AS id,
        'import' AS kind,
        replace(f.imported_at, ' ', 'T') AS ts,
        f.show_id AS show_id,
        s.title AS show_title,
        f.season_number AS season_number,
        f.episode_number AS episode_number,
        'AVAILABLE' AS stage,
        'import_completed' AS event_type,
        ('Imported ' || COALESCE(f.original_name, f.file_path)) AS message,
        f.release_title AS release_title,
        f.indexer_name AS indexer_name
      FROM episode_files f
      LEFT JOIN shows s ON s.id = f.show_id
    `);
  }

  const conditions: string[] = [];
  if (filter.showId) {
    conditions.push(`show_id = ?`);
    params.push(filter.showId);
  }
  if (filter.query?.trim()) {
    conditions.push(`(show_title LIKE ? OR message LIKE ? OR release_title LIKE ?)`);
    const like = `%${filter.query.trim()}%`;
    params.push(like, like, like);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch one extra row to know whether another page exists.
  const rows = self.db.query(`
    SELECT * FROM (
      ${selects.join('\n      UNION ALL\n')}
    )
    ${where}
    ORDER BY ts DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit + 1, offset) as any[];

  return {
    items: rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      kind: r.kind as 'grab' | 'import' | 'event',
      timestamp: r.ts as string,
      showId: r.show_id ?? null,
      showTitle: r.show_title ?? null,
      seasonNumber: r.season_number ?? null,
      episodeNumber: r.episode_number ?? null,
      stage: r.stage ?? null,
      eventType: r.event_type ?? null,
      message: r.message ?? '',
      releaseTitle: r.release_title ?? null,
      indexerName: r.indexer_name ?? null,
    })),
    hasMore: rows.length > limit,
  };
}
