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
