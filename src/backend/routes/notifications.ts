import { sql, desc } from 'drizzle-orm';
import * as schema from '../db/schema';
import { db } from '../db';
import { json, errorResponse } from './_shared';

const DISMISSED_SETTING_KEY = 'notifications:dismissed';

function loadDismissedIds(): Set<string> {
  const raw = db.getSetting(DISMISSED_SETTING_KEY);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDismissedIds(ids: Set<string>): void {
  db.setSetting(DISMISSED_SETTING_KEY, [...ids]);
}

export function notificationRoutes() {
  return {
    "/api/notifications": {
      async GET() {
        try {
          const dismissed = loadDismissedIds();

          const healthIssues = db.drizz.select().from(schema.systemHealth)
            .where(sql`status IN ('degraded', 'down')`)
            .orderBy(desc(schema.systemHealth.checked_at))
            .all() as any[];

          // reason_code IS NOT NULL is NOT enough to mark an event as a
          // failure — GRAB_SUCCEEDED (and future success-category codes)
          // carry a reason code too. Exclude the success category so a
          // successful "Submitted to TorBox" never surfaces under
          // "Needs Attention".
          const failedEvents = db.drizz.select().from(schema.pipelineEvents)
            .where(sql`(stage = 'FAILED' OR (reason_code IS NOT NULL AND reason_category != 'success'))`)
            .orderBy(desc(schema.pipelineEvents.created_at))
            .limit(20)
            .all() as any[];

          const recentPipeline = db.drizz.select().from(schema.pipelineEvents)
            .where(sql`stage != 'FAILED' AND (reason_code IS NULL OR reason_category = 'success')`)
            .orderBy(desc(schema.pipelineEvents.created_at))
            .limit(10)
            .all() as any[];

          const recentAudit = db.drizz.select().from(schema.auditLogs)
            .orderBy(desc(schema.auditLogs.id))
            .limit(10)
            .all() as any[];

          const priority = [
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
          ].filter((n) => !dismissed.has(n.id));

          return json({
            priority,
            recent: [
              ...recentAudit.map((a: any) => ({
                id: `audit:${a.id}`,
                type: 'event' as const,
                severity: 'info' as const,
                title: a.message?.slice(0, 100) ?? 'Event',
                message: a.message ?? null,
                timestamp: a.timestamp,
              })),
              ...recentPipeline.map((e: any) => ({
                id: `event:${e.id}`,
                type: 'event' as const,
                severity: 'info' as const,
                title: e.message?.slice(0, 100) ?? 'Event',
                message: e.message ?? null,
                timestamp: e.created_at,
              })),
            ],
            unreadCount: priority.length,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/notifications/dismiss": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
          const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
          if (ids.length === 0) return errorResponse('ids[] is required');
          const dismissed = loadDismissedIds();
          for (const id of ids) dismissed.add(id);
          saveDismissedIds(dismissed);
          return json({ ok: true, dismissed: dismissed.size });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/notifications/restore": {
      async POST() {
        try {
          db.removeSetting(DISMISSED_SETTING_KEY);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
