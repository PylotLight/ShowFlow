import { sql, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import { db } from '../db';
import { json, errorResponse } from './_shared';

export function notificationRoutes() {
  return {
    "/api/notifications": {
      async GET() {
        try {
          const healthIssues = db.drizz.select().from(schema.systemHealth)
            .where(sql`status IN ('degraded', 'down')`)
            .orderBy(desc(schema.systemHealth.checked_at))
            .all() as any[];

          const failedEvents = db.drizz.select().from(schema.pipelineEvents)
            .where(sql`stage = 'FAILED' OR reason_code IS NOT NULL`)
            .orderBy(desc(schema.pipelineEvents.created_at))
            .limit(20)
            .all() as any[];

          const recentEvents = db.drizz.select().from(schema.pipelineEvents)
            .where(sql`stage != 'FAILED' AND reason_code IS NULL`)
            .orderBy(desc(schema.pipelineEvents.created_at))
            .limit(10)
            .all() as any[];

          return json({
            priority: [
              ...healthIssues.map((h: any) => ({
                id: `health:${h.component_type}:${h.component_id}`,
                type: 'health' as const,
                severity: h.status === 'down' ? 'error' : 'warning' as const,
                title: `${h.component_name} is ${h.status}`,
                message: h.message ?? null,
                reasonCode: h.reason_code ?? null,
                timestamp: h.checked_at,
                link: '/settings?tab=health',
              })),
              ...failedEvents.map((e: any) => ({
                id: `pipeline:${e.id}`,
                type: 'pipeline_failure' as const,
                severity: 'error' as const,
                title: e.message?.slice(0, 100) ?? 'Pipeline event failed',
                message: e.message ?? null,
                reasonCode: e.reason_code ?? null,
                timestamp: e.created_at,
                link: null,
              })),
            ],
            recent: recentEvents.map((e: any) => ({
              id: `event:${e.id}`,
              type: 'event' as const,
              severity: 'info' as const,
              title: e.message?.slice(0, 100) ?? 'Event',
              message: e.message ?? null,
              timestamp: e.created_at,
            })),
            unreadCount: healthIssues.length + failedEvents.length,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
