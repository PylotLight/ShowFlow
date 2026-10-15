import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { json, errorResponse, getJellyfinClient, type RouteReq } from './_shared';
import {
  getLastMediaRefresh, invalidateConnectSettings, mediaTargets, plexClientFrom, testTarget,
} from '../core/connect';
import { runRefresh } from '../core/connect/media_refresh';
import {
  loadConnectSettings, maskSettings, mergeIncomingMediaRefresh, mergeIncomingTarget, saveConnectSettings,
} from '../core/connect/settings';
import { CONNECT_EVENTS, CONNECT_EVENT_LABELS } from '../core/connect/types';

/** Settings > Connect: notification targets + Jellyfin/Plex refresh. */
export function connectRoutes() {
  const view = () => {
    const s = loadConnectSettings(db);
    return {
      ...maskSettings(s),
      events: CONNECT_EVENTS.map(id => ({ id, label: CONNECT_EVENT_LABELS[id] })),
      lastRefresh: getLastMediaRefresh(),
    };
  };

  return {
    "/api/connect": {
      GET() {
        try { return json(view()); } catch (err) { return errorResponse(err, 500); }
      },
    },

    "/api/connect/targets": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, any>;
          const s = loadConnectSettings(db);
          const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
          const existing = s.targets.find(t => t.id === id);
          const merged = mergeIncomingTarget({ ...body, id }, existing);
          if (!merged.ok) return errorResponse(merged.error);
          s.targets = existing
            ? s.targets.map(t => (t.id === id ? merged.target : t))
            : [...s.targets, merged.target];
          saveConnectSettings(db, s);
          invalidateConnectSettings();
          db.logEvent({ type: 'config', entityType: 'system', message: `Notification target "${merged.target.name}" saved` });
          return json({ ok: true, id, ...view() });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/connect/targets/:id": {
      DELETE(req: RouteReq) {
        try {
          const s = loadConnectSettings(db);
          const before = s.targets.length;
          s.targets = s.targets.filter(t => t.id !== req.params.id);
          if (s.targets.length === before) return errorResponse('Target not found', 404);
          saveConnectSettings(db, s);
          invalidateConnectSettings();
          return json({ ok: true, ...view() });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    /** Test a target as currently typed (saved or not); masked secrets fall back to the stored copy. */
    "/api/connect/targets/test": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, any>;
          const s = loadConnectSettings(db);
          const id = typeof body.id === 'string' && body.id ? body.id : 'test';
          const merged = mergeIncomingTarget({ ...body, id, name: body.name || 'test' }, s.targets.find(t => t.id === id));
          if (!merged.ok) return json({ ok: false, message: merged.error });
          const res = await testTarget(merged.target);
          return json(res.ok ? { ok: true, message: 'Test notification sent' } : { ok: false, message: res.error });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/connect/media": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, any>;
          const s = loadConnectSettings(db);
          const merged = mergeIncomingMediaRefresh(body, s.mediaRefresh);
          if (!merged.ok) return errorResponse(merged.error);
          s.mediaRefresh = merged.value;
          saveConnectSettings(db, s);
          invalidateConnectSettings();
          return json({ ok: true, ...view() });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    /**
     * Test media-server reachability. Body: { server: 'jellyfin' | 'plex', plex? }.
     * Plex accepts the unsaved form values (masked token = stored token).
     */
    "/api/connect/media/test": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as Record<string, any>;
          if (body.server === 'jellyfin') {
            const client = getJellyfinClient();
            if (!client) return json({ ok: false, message: 'Set up Jellyfin under Integrations first' });
            const r = await client.test();
            return json(r.ok ? { ok: true, message: `Connected to ${r.serverName ?? 'Jellyfin'} ${r.version ?? ''}`.trim() } : r);
          }
          if (body.server === 'plex') {
            const s = loadConnectSettings(db);
            const merged = mergeIncomingMediaRefresh({ plex: body.plex ?? {} }, s.mediaRefresh);
            if (!merged.ok) return json({ ok: false, message: merged.error });
            const client = plexClientFrom(merged.value.plex);
            if (!client) return json({ ok: false, message: 'Plex URL and token are required' });
            return json(await client.test());
          }
          return errorResponse('server must be jellyfin or plex');
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    /** Manually refresh a folder now (debug / "did my mapping work?"). Body: { path }. */
    "/api/connect/media/refresh": {
      async POST(req: Request) {
        try {
          const body = (await req.json().catch(() => ({}))) as { path?: string };
          if (!body.path) return errorResponse('path is required');
          const targets = mediaTargets(loadConnectSettings(db));
          if (!targets.jellyfin && !targets.plex) return json({ ok: false, message: 'No media server refresh is enabled' });
          return json({ ok: true, run: await runRefresh([body.path], targets) });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
