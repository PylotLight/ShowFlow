import { eq, and } from 'drizzle-orm';
import * as schema from './schema';
import type { DatabaseManager } from './index';
import { describeReasonCode, type ReasonCode } from '../core/pipeline/reason_codes';

export type HealthComponentType = 'indexer' | 'download_client' | 'import_path';
export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface UpsertHealthInput {
  componentType: HealthComponentType;
  componentId: string;
  componentName: string;
  status: HealthStatus;
  reasonCode?: ReasonCode;
  message?: string;
  metadata?: any;
}

/**
 * Records the current status of one component (one indexer, one download
 * client, one import path). Callers are expected to poll and call this on
 * a schedule - see the note in schema.ts, there's no poller wired up to
 * call this yet, this is the write side waiting for one.
 */
export function upsertHealthStatus(self: DatabaseManager, input: UpsertHealthInput) {
  const reasonCategory = input.reasonCode ? describeReasonCode(input.reasonCode)?.category ?? null : null;
  const values = {
    component_type: input.componentType,
    component_id: input.componentId,
    component_name: input.componentName,
    status: input.status,
    reason_code: input.reasonCode ?? null,
    reason_category: reasonCategory,
    message: input.message ?? null,
    metadata_json: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    checked_at: new Date().toISOString(),
  };

  return self.drizz
    .insert(schema.systemHealth)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.systemHealth.component_type, schema.systemHealth.component_id],
      set: values,
    })
    .run();
}

export function removeHealthComponent(self: DatabaseManager, componentType: HealthComponentType, componentId: string) {
  return self.drizz
    .delete(schema.systemHealth)
    .where(and(eq(schema.systemHealth.component_type, componentType), eq(schema.systemHealth.component_id, componentId)))
    .run();
}

export interface HealthSnapshot {
  overallStatus: HealthStatus;
  byType: Record<HealthComponentType, (typeof schema.systemHealth.$inferSelect)[]>;
}

/**
 * The full current-state snapshot, grouped by component type, plus a
 * single overall status derived from the worst component - this is what
 * powers the "SYSTEM STATUS: Degraded (1 issue)" glanceable line the brief
 * asks for in §4. Any component `down` makes the whole system `down`;
 * otherwise any `degraded` component makes it `degraded`; otherwise
 * `healthy`. An empty snapshot (nothing polled yet) reads as `healthy`
 * rather than `down` - absence of data isn't evidence of a problem.
 */
export function getHealthSnapshot(self: DatabaseManager): HealthSnapshot {
  const rows = self.drizz.select().from(schema.systemHealth).all();

  const byType: HealthSnapshot['byType'] = { indexer: [], download_client: [], import_path: [] };
  for (const row of rows) {
    const key = row.component_type as HealthComponentType;
    if (key in byType) byType[key]!.push(row);
  }

  let overallStatus: HealthStatus = 'healthy';
  for (const row of rows) {
    if (row.status === 'down') { overallStatus = 'down'; break; }
    if (row.status === 'degraded') overallStatus = 'degraded';
  }

  return { overallStatus, byType };
}
