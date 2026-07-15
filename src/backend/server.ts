// IMPORTANT: proxy-patch MUST be the first import — it patches globalThis.fetch
// during module evaluation, before any code that makes network calls can run.
import "./proxy-patch";

import { serve, type ServerWebSocket } from "bun";
type RouteReq = Request & { params: Record<string, string> };
import fs from "node:fs";
import path from "node:path";
import index from "../frontend/index.html";

// favicon.svg is linked from index.html; logo.svg is only ever referenced
// as a runtime string (`<img src="/assets/logo.svg">` in Sidebar.tsx), so
// Bun's bundler can't discover it through static analysis of the HTML/JS
// graph. Embedding both explicitly with `with { type: "file" }` bakes them
// into the compiled binary itself, so no separate dist/assets folder needs
// to exist on disk at runtime — see the /assets/:file route below.
import faviconAsset from "../frontend/assets/favicon.svg" with { type: "file" };
import logoAsset from "../frontend/assets/logo.svg" with { type: "file" };

const embeddedAssets: Record<string, string> = {
  "favicon.svg": faviconAsset,
  "logo.svg": logoAsset,
};

// The service worker and its offline fallback page must be served from
// fixed top-level paths (a SW's own scope is the directory it's served
// from) — Bun's HTML-import bundler would otherwise fingerprint/hash them
// like any other asset, which breaks `navigator.serviceWorker.register("/sw.js")`.
// Embedding as `{ type: "file" }` keeps them out of that bundling path and
// bakes them into the compiled binary like the other embedded assets above.
//
// Both resolve to a raw file-path string at runtime (that's what Bun's
// `type: "file"` attribute does), but TypeScript's *static* type for each
// disagrees, for two different reasons:
//  - sw.js is a real, TS-resolvable .js file — with `allowJs` on, TS finds
//    the actual module (no default export) before it ever consults an
//    ambient `declare module "*.js"`-style fallback, so a wildcard
//    declaration here wouldn't even be consulted.
//  - offline.html matches bun-types' generic `"*.html" -> HTMLBundle`
//    ambient declaration, the shape meant for index.html's very different
//    SPA-bundling import below — not a bare string.
// The `type: "file"` import attribute changes Bun's runtime behavior, but
// TypeScript's resolver doesn't key off import attributes at all, so
// neither inferred type matches what's actually returned. Casting at the
// source is more robust than an ambient-declaration workaround that either
// gets ignored (sw.js) or would be fragile to rely on (offline.html).
import swAssetRaw from "../frontend/sw.js" with { type: "file" };
import offlineAssetRaw from "../frontend/offline.html" with { type: "file" };
const swAsset = swAssetRaw as unknown as string;
const offlineAsset = offlineAssetRaw as unknown as string;

// Compiled in by build.ts's `define` block — see bun-env.d.ts for why these
// are typed as possibly-undefined (dev mode via `bun --hot` never runs the
// build step, so the define substitution never happens there).
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "development";
const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "development";



import { db, ConfigSchema, ProwlarrConfigSchema, type Config } from "./db";
import * as schema from "./db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { ProviderFactory, type ProviderType } from "./providers/factory";
import { TVDBProvider } from "./providers/tvdb";
import { Scheduler } from "./core/scheduler";
import { SyncManager } from "./core/sync_manager";
import { SystemManager } from "./core/system_manager";
import { Oracle } from "./parser/oracle";
import { GrabberService } from "./core/grabber_service";
import { IndexerFactory } from "./providers/indexers/factory";
import type { IndexerResult } from "./providers/indexers/types";
import { NATIVE_INDEXER_META, type NativeIndexerConfig, type NativeIndexerId } from "./providers/indexers/native/types";
import { runBackup, listBackups, uploadBackup, restoreBackup } from "./core/backup";
import { createApiDebugLog, subscribeDebugLogs, getDebugLogs, clearDebugLogs, isDebugEnabled } from "./core/debug";
import { SonarrClient } from "./providers/sonarr/client";
import { SonarrImporter, type SonarrTypeMapping } from "./providers/sonarr/import";
import { SonarrConfigSchema, JellyfinConfigSchema } from "./db";
import { JellyfinClient } from "./providers/jellyfin/client";
import { JellyfinSync } from "./providers/jellyfin/sync";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { listReleases, downloadAndInstall, triggerActivate, getSupervisorStatus } from "./core/updates_manager";

const ADMIN_TOKEN = initAdminToken();

function initAdminToken(): string {
  const existing = db.getSetting("admin_token");
  if (existing) return existing;
  const token = randomUUID();
  db.setSetting("admin_token", token);
  return token;
}

// ---- Config -----------------------------------------------------------

let cachedConfig: Config | null = null;
let cachedConfigTime = 0;
const CONFIG_CACHE_TTL = 5_000;

function loadConfig(): Config {
  const now = Date.now();
  if (cachedConfig && (now - cachedConfigTime) < CONFIG_CACHE_TTL) return cachedConfig;

  const settings = db.getAllSettings();
  const configObj: any = {};
  for (const s of settings) {
    try {
      configObj[s.key] = JSON.parse(s.value);
    } catch {
      configObj[s.key] = s.value;
    }
  }

  if (Object.keys(configObj).length === 0) {
    // Auto-init with defaults for a fresh database
    console.info("[config] No config found — applying defaults for fresh database");
    db.setSetting("defaultProvider", "tvdb");
    db.setSetting("onCollision", "skip");
    db.setSetting("dryRun", false);
    db.setSetting("seasonFolderFormat", "Season {season}");
    db.setSetting("apiKeys", {});
    db.setSetting("downloadClient", { type: "blackhole" });
    return loadConfig();
  }

  cachedConfig = ConfigSchema.parse(configObj);
  cachedConfigTime = now;
  return cachedConfig;
}

function invalidateConfigCache() {
  cachedConfig = null;
}

function reinitializeServices() {
  const newConfig = loadConfig();
  if (systemManager) {
    // System manager doesn't need reinitialization for config changes
  }
  // Scheduler would need to be reinitialized if we want to apply config changes immediately
  // For now, we'll let it continue with the existing config
}

function isProviderType(value: string): value is ProviderType {
  return value === "tmdb" || value === "tvdb" || value === "anilist";
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

// SQLite's CURRENT_TIMESTAMP produces UTC time formatted as
// "YYYY-MM-DD HH:MM:SS" - no 'T', no 'Z', no offset. `new Date(...)` on a
// string in that shape is parsed as *local* time by JS engines (only the
// ISO "T...Z" form is treated as UTC), so every timestamp silently drifts
// by the server's UTC offset once it hits the browser. Normalizing to a
// proper ISO-8601 UTC string here fixes that at the source rather than
// requiring every frontend consumer to know about the quirk.
function toIsoUtc(sqliteTimestamp: string): string {
  if (!sqliteTimestamp) return sqliteTimestamp;
  // Already ISO-ish (has 'T' or ends with 'Z')? Leave it alone.
  if (sqliteTimestamp.includes('T') || sqliteTimestamp.endsWith('Z')) return sqliteTimestamp;
  return `${sqliteTimestamp.replace(' ', 'T')}Z`;
}

function errorResponse(err: unknown, status = 400) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${message}`);
  return json({ error: message }, { status });
}

// ---- Admin auth (updates routes only) -----------------------------------
// Nothing else in this API requires auth today (self-hosted, single-user,
// expected to sit behind the operator's own network boundary) — but the
// updates routes are uniquely dangerous: they download and execute an
// arbitrary binary fetched from GitHub and can trigger a process restart.
// Gated separately behind its own token rather than piggybacking on
// anything user-facing, since there's no broader auth system to hook into
// yet. Generated once on first boot and persisted to the database.
function checkAdminAuth(req: Request): boolean {
  const token = ADMIN_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, and needs equal-length buffers regardless — pad the shorter one
  // so a length mismatch doesn't leak via that exception path either.
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // constant-time-ish no-op, avoids an early return that could be timed
    return false;
  }
  return timingSafeEqual(a, b);
}

function unauthorized() {
  return json({ error: "Unauthorized" }, { status: 401 });
}

// ---- Poster resolution --------------------------------------------------
// Providers return raw, un-normalized `metadata` per source. There's no
// shared "posterUrl" field yet, so we derive one here per provider rather
// than changing the shared Show type (that's provider-layer territory).

function extractPosterUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      return metadata.image ?? metadata.artworks?.[0]?.image ?? null;
    case "tmdb":
      return metadata.poster_path ? `https://image.tmdb.org/t/p/w500${metadata.poster_path}` : null;
    case "anilist":
      return metadata.coverImage?.large ?? metadata.coverImage?.medium ?? null;
    default:
      return null;
  }
}

function extractBackdropUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      const fanart = metadata.artworks?.find((a: any) => a.type === 15 || a.type === 3);
      return fanart?.image ?? null;
    case "tmdb":
      return metadata.backdrop_path ? `https://image.tmdb.org/t/p/w1280${metadata.backdrop_path}` : null;
    case "anilist":
      return metadata.bannerImage ?? null;
    default:
      return null;
  }
}

// A tiny 1x1 transparent-ish placeholder isn't very useful in a glass UI, so
// missing posters fall through to this SVG "no signal" card instead of a
// broken-image icon.
function getProwlarrIndexer() {
  const raw = db.getSetting('prowlarr');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = ProwlarrConfigSchema.parse(parsed);
    if (!config.enabled) return null;
    return IndexerFactory.create('prowlarr', config);
  } catch (err) {
    console.error('[api] Prowlarr is configured but invalid:', err);
    return null;
  }
}

function getSonarrClient(): SonarrClient | null {
  const raw = db.getSetting('sonarr');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = SonarrConfigSchema.parse(parsed);
    if (!config.enabled || !config.baseUrl || !config.apiKey) return null;
    return new SonarrClient(config.baseUrl, config.apiKey, config.apiVersion);
  } catch (err) {
    console.error('[api] Sonarr is configured but invalid:', err);
    return null;
  }
}

function getJellyfinClient(): JellyfinClient | null {
  const raw = db.getSetting('jellyfin');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = JellyfinConfigSchema.parse(parsed);
    if (!config.enabled || !config.baseUrl || !config.apiKey) return null;
    return new JellyfinClient(config.baseUrl, config.apiKey);
  } catch (err) {
    console.error('[api] Jellyfin is configured but invalid:', err);
    return null;
  }
}

function getNativeIndexers(): { config: NativeIndexerConfig; instance: ReturnType<typeof IndexerFactory.createNative> }[] {
  const raw = db.getSetting('nativeIndexers');
  if (!raw) return [];
  try {
    const configs: NativeIndexerConfig[] = JSON.parse(typeof raw === 'string' ? raw : raw);
    return configs
      .filter(c => c.enabled)
      .map(c => ({ config: c, instance: IndexerFactory.createNative(c) }));
  } catch (err) {
    console.error('[api] Native indexers config is invalid:', err);
    return [];
  }
}

// ScoredRelease carries a live `indexer` instance (needed to grab it) whose
// private fields (including the Prowlarr API key!) are still enumerable at
// runtime despite the `private` keyword being TS-only. Never JSON-serialize
// a release without stripping it first.
function serializeRelease({ indexer, ...rest }: any) {
  return rest;
}

const NO_SIGNAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="oklch(0.19 0.025 265)"/>
  <rect x="0.5" y="0.5" width="499" height="749" fill="none" stroke="oklch(1 0 0 / 10%)"/>
  <circle cx="250" cy="345" r="28" fill="none" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <line x1="230" y1="325" x2="270" y2="365" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <text x="250" y="410" font-family="ui-monospace, monospace" font-size="15" fill="oklch(0.65 0.02 265)" text-anchor="middle">NO SIGNAL</text>
</svg>`;

// ---- Server ---------------------------------------------------------------

// Track WebSocket clients for debug log streaming
const debugWsClients = new Set<WebSocket>();

// Set by the SIGTERM handler below. /internal/ready checks this first and
// immediately returns 503 once it's set, so the supervisor's readiness
// polling and the shutdown-drain window use the exact same signal instead
// of two independently-maintained notions of "still up."
let shuttingDown = false;

function wrapWithDebug(path: string, method: string, handler: Function): Function {
  return async function (...args: any[]) {
    if (!isDebugEnabled()) return (handler as any)(...args);
    const req = args[0] as Request | undefined;
    const actualUrl = req?.url || path;
    const start = performance.now();
    let reqBody: unknown = undefined;
    if (req && method !== 'GET' && method !== 'DELETE') {
      try { reqBody = await req.clone().json(); } catch { }
    }
    try {
      const res = await (handler as any)(...args);
      const duration = Math.round(performance.now() - start);
      const status = res instanceof Response ? res.status : 200;
      let resBody: unknown = undefined;
      if (res instanceof Response && status < 300) {
        try { const text = await res.clone().text(); resBody = text ? JSON.parse(text) : undefined; } catch { }
      }
      createApiDebugLog(method, path, status, duration, reqBody, resBody, undefined, actualUrl);
      return res;
    } catch (err) {
      const duration = Math.round(performance.now() - start);
      createApiDebugLog(method, path, 500, duration, reqBody, undefined, err instanceof Error ? err.message : String(err), actualUrl);
      throw err;
    }
  };
}

const routeDefinitions = {
  // Previously read from `dist/assets` on disk via an `import.meta.dir`-
  // relative path, which depended on a separate `bun run build` output
  // being copied into the image at a matching location. Now served from
  // the embedded files imported above — no disk dependency, works
  // identically whether run via `bun src/backend/server.ts` in dev or as
  // the compiled `showflow` binary in production.
  "/assets/:file": {
    GET(req: RouteReq) {
      const file = req.params.file!;
      const embedded = embeddedAssets[file];
      if (!embedded) return new Response("", { status: 404 });
      const ext = file.split(".").pop() ?? '';
      const types: Record<string, string> = { svg: "image/svg+xml", png: "image/png", css: "text/css", js: "application/javascript" };
      return new Response(Bun.file(embedded), { headers: { "Content-Type": types[ext] || "application/octet-stream" } });
    }
  },

  // Served at the fixed top-level path a SW registration/scope requires.
  // No-cache: browsers only check for a new SW script periodically (~24h)
  // otherwise, and a stale cached SW after a release update is exactly the
  // kind of mismatch this whole mechanism exists to avoid.
  "/sw.js": {
    GET() {
      return new Response(Bun.file(swAsset), {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/",
        },
      });
    },
  },

  "/offline.html": {
    GET() {
      return new Response(Bun.file(offlineAsset), {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
      });
    },
  },

  // Serves the bundled React app for any path that isn't an /api/* route
  // below. This was imported but never wired in - the actual cause of
  // "nothing loads".
  "/*": index,

  "/api/config": {
    async GET() {
      try {
        return json(loadConfig());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async PATCH(req: RouteReq) {
      try {
        const body = (await req.json()) as Partial<Config>;
        for (const [k, v] of Object.entries(body)) {
          db.setSetting(k, v);
        }
        invalidateConfigCache();
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/show-profiles": {
    async GET() {
      try {
        return json(db.listShowProfiles());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const { id, name, rootFolderPath } = await req.json();
        if (!id || !name || !rootFolderPath) return errorResponse("id, name, and rootFolderPath are required");
        db.saveShowProfile(id, name, rootFolderPath);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/show-profiles/:id": {
    async DELETE(req: RouteReq) {
      try {
        db.removeShowProfile(req.params.id!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/settings": {
    async GET() {
      try {
        return json(db.getAllSettings());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const { key, value } = await req.json();
        if (!key) return errorResponse("Key is required");
        if (key === "prowlarr") {
          // Partial saves (e.g. toggling enabled before URL is set) must
          // merge with whatever is already stored so validation doesn't
          // reject a missing-but-unchanged field.
          const existing = db.getSetting('prowlarr');
          let merged = value;
          if (existing) {
            try {
              const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
              merged = { ...parsed, ...value };
            } catch { }
          }
          const result = ProwlarrConfigSchema.safeParse(merged);
          if (!result.success) {
            return errorResponse(result.error.issues.map(i => i.message).join("; "));
          }
          db.setSetting(key, result.data);
          invalidateConfigCache();
          return json({ ok: true });
        }
        if (key === "sonarr") {
          const existing = db.getSetting('sonarr');
          let merged = value;
          if (existing) {
            try {
              const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
              merged = { ...parsed, ...value };
            } catch { }
          }
          const result = SonarrConfigSchema.safeParse(merged);
          if (!result.success) {
            return errorResponse(result.error.issues.map(i => i.message).join("; "));
          }
          db.setSetting(key, result.data);
          invalidateConfigCache();
          return json({ ok: true });
        }
        if (key === "jellyfin") {
          const existing = db.getSetting('jellyfin');
          let merged = value;
          if (existing) {
            try {
              const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
              merged = { ...parsed, ...value };
            } catch { }
          }
          const result = JellyfinConfigSchema.safeParse(merged);
          if (!result.success) {
            return errorResponse(result.error.issues.map(i => i.message).join("; "));
          }
          db.setSetting(key, result.data);
          invalidateConfigCache();
          return json({ ok: true });
        }
        db.setSetting(key, value);
        invalidateConfigCache();
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    async DELETE(req: RouteReq) {
      try {
        const { key } = await req.json();
        if (!key) return errorResponse("Key is required");
        db.removeSetting(key);
        invalidateConfigCache();
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/system/scan": {
    async POST() {
      try {
        const result = await systemManager.scan();
        db.logEvent({ type: 'scan', entityType: 'system', message: 'Full library scan completed' });
        return json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.logEvent({ type: 'error', entityType: 'system', message: `Library scan failed: ${message}` });
        return errorResponse(err, 500);
      }
    },
  },

  "/api/system/watch/start": {
    async POST() {
      try {
        const result = await systemManager.startWatcher();
        db.logEvent({ type: 'watcher', entityType: 'system', message: 'Watcher services started' });
        return json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.logEvent({ type: 'error', entityType: 'system', message: `Failed to start watcher: ${message}` });
        return errorResponse(err, 500);
      }
    },
  },

  "/api/system/watch/stop": {
    async POST() {
      try {
        const result = await systemManager.stopWatcher();
        db.logEvent({ type: 'watcher', entityType: 'system', message: 'Watcher services stopped' });
        return json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.logEvent({ type: 'error', entityType: 'system', message: `Failed to stop watcher: ${message}` });
        return errorResponse(err, 500);
      }
    },
  },

  "/api/system/watch/rescan": {
    async POST() {
      try {
        const result = await systemManager.rescanWatcher();
        db.logEvent({ type: 'scan', entityType: 'system', message: 'Watch folder rescan completed' });
        return json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.logEvent({ type: 'error', entityType: 'system', message: `Watch folder rescan failed: ${message}` });
        return errorResponse(err, 500);
      }
    },
  },

  "/api/system/status": {
    async GET() {
      try {
        return json({
          watching: systemManager.isWatching(),
          releaseId: BUILD_COMMIT,
          version: BUILD_VERSION,
        });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/system/processing": {
    async GET() {
      try {
        return json(systemManager.getProcessingFiles());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Task scheduling --------------------------------------------------

  "/api/tasks": {
    async GET() {
      try {
        const tasks = db.listTasks();
        const definitions = scheduler.getTaskDefinitions();
        
        const enrichedTasks = tasks.map((task: any) => {
          const def = definitions.find(d => d.name === task.name);
          return {
            name: task.name,
            displayName: def?.displayName || task.name,
            description: def?.description || '',
            category: def?.category || 'system',
            intervalMinutes: task.interval_minutes,
            enabled: !!task.enabled,
            lastExecution: task.last_execution,
            lastDurationMs: task.last_duration_ms,
            nextExecution: task.next_execution,
          };
        });
        
        return json(enrichedTasks);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/tasks/definitions": {
    async GET() {
      try {
        return json(scheduler.getTaskDefinitions());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/tasks/:name": {
    async PATCH(req: RouteReq) {
      try {
        const name = req.params.name!;
        if (!name) return errorResponse("Task name is required", 400);
        const body = await req.json();
        
        scheduler.updateTaskConfig(name, {
          enabled: body.enabled,
          intervalMinutes: body.intervalMinutes,
        });
        
        return json({ success: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const name = req.params.name!;
        if (!name) return errorResponse("Task name is required", 400);
        const result = await scheduler.runTaskNow(name);
        return json(result);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Activity feed ---------------------------------------------------
  // Backs the dashboard ticker and watcher activity panel. Reads only -
  // events are written by SyncManager and the download watcher.

  "/api/events": {
    async GET(req: RouteReq) {
      try {
        const url = new URL(req.url);
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const events = db.listRecentEvents(Number.isNaN(limit) ? 20 : limit);
        return json(
          events.map((e: any) => ({
            id: e.id,
            type: e.event_type,
            entityType: e.entity_type,
            entityId: e.entity_id,
            message: e.message,
            timestamp: toIsoUtc(e.timestamp),
          })),
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/qualities": {
    async GET() {
      try {
        return json(db.listQualities());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = await req.json();
        db.saveQuality(body);
        return json({ ok: true }, { status: 201 });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/qualities/:id": {
    async DELETE(req: RouteReq) {
      try {
        db.removeQuality(req.params.id!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/profiles": {
    async GET() {
      try {
        return json(db.listProfiles());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = await req.json();
        db.saveProfile(body);
        return json({ ok: true }, { status: 201 });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/profiles/:id": {
    async DELETE(req: RouteReq) {
      try {
        db.removeProfile(req.params.id!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/profiles/:id/formats": {
    async GET(req: RouteReq) {
      try {
        return json(db.getProfileFormats(req.params.id!));
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const { formatId, type } = await req.json();
        db.addProfileFormat(req.params.id!, formatId, type);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    async DELETE(req: RouteReq) {
      try {
        const { formatId } = await req.json();
        db.removeProfileFormat(req.params.id!, formatId);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/profiles/:id/qualities": {
    async GET(req: RouteReq) {
      try {
        return json(db.getProfileQualities(req.params.id!));
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const { qualityId } = await req.json();
        if (!qualityId) return errorResponse("qualityId is required");
        db.addProfileQuality(req.params.id!, qualityId);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    async DELETE(req: RouteReq) {
      try {
        const { qualityId } = await req.json();
        if (!qualityId) return errorResponse("qualityId is required");
        db.removeProfileQuality(req.params.id!, qualityId);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/profiles/:id/indexers": {
    async PUT(req: RouteReq) {
      try {
        const body = await req.json();
        db.saveProfileIndexers(req.params.id!, body);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/custom-formats": {
    async GET() {
      try {
        return json(db.listCustomFormats());
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = await req.json();
        db.saveCustomFormat(body);
        return json({ ok: true }, { status: 201 });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/custom-formats/:id": {
    async DELETE(req: RouteReq) {
      try {
        db.removeCustomFormat(req.params.id!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Shows ---------------------------------------------------------

  "/api/shows": {
    async GET() {
      try {
        const shows = db.listShows();
        const showIds = shows.map((s: any) => s.id);
        
        // Get tracking and grabbed status for each show
        const episodeStats = showIds.length > 0 
          ? db.drizz.select({
              show_id: schema.episodes.show_id,
              is_tracked: schema.episodes.is_tracked,
              file_path: schema.episodes.file_path,
            })
            .from(schema.episodes)
            .where(inArray(schema.episodes.show_id, showIds))
            .all() as { show_id: string; is_tracked: number; file_path: string | null }[]
          : [];
        
        const statsMap = new Map<string, { tracked_count: number; grabbed_count: number }>();
        episodeStats.forEach(ep => {
          const existing = statsMap.get(ep.show_id) || { tracked_count: 0, grabbed_count: 0 };
          if (ep.is_tracked === 1) existing.tracked_count++;
          if (ep.file_path) existing.grabbed_count++;
          statsMap.set(ep.show_id, existing);
        });
        

        
        return json(
          shows.map((s: any) => {
            const stats = statsMap.get(s.id) || { tracked_count: 0, grabbed_count: 0 };
            return {
              id: s.id,
              providerType: s.provider_type,
              title: s.title,
              profile: s.profile,
              seriesType: s.series_type,
              uuid: s.id,
              rootFolderPath: s.root_folder_path,
              lastUpdated: s.last_updated,
              addedAt: s.added_at,
              trackedCount: stats.tracked_count,
              grabbedCount: stats.grabbed_count,
            };
          }),
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = (await req.json()) as { source: string; providerId: string; name?: string; rootFolderPath?: string; profile?: string; showProfileId?: string; seriesType?: string };
        if (!body?.source || !body?.providerId) {
          return errorResponse("Both `source` and `providerId` are required.");
        }
        if (!isProviderType(body.source)) {
          return errorResponse(`Unknown source "${body.source}". Must be one of: tmdb, tvdb, anilist.`);
        }

        // Check if this provider+ID is already linked to a show
        const existing = db.getShowByProvider(body.source, body.providerId);
        if (existing) {
          return json({
            id: existing.id,
            title: existing.title,
            providerType: body.source,
            message: 'Show already in library',
          }, { status: 200 });
        }

        const config = loadConfig();
        const provider = ProviderFactory.getProvider(body.source, config);

        /*
         * Always read provider metadata before saving. The client-visible
         * search identifier may be a provider-specific slug such as
         * `series-452039`; provider.getShow() normalizes it and returns the
         * canonical ID used by episodes, artwork, and later sync calls.
         */
        const showData = await provider.getShow(body.providerId);
        const providerId = showData.id;
        const title = body.name?.trim() || showData.title;

        const showUuid = crypto.randomUUID();
        const seriesType = body.seriesType || 'standard';

        // When no root folder or profile is explicitly chosen, pick the
        // first configured folder profile so the show always has a
        // physical destination.
        if (!body.showProfileId && !body.rootFolderPath) {
          const showProfiles = db.listShowProfiles();
          if (showProfiles.length > 0) {
            body.showProfileId = showProfiles[0]?.id;
          }
        }

        db.saveShow({
          uuid: showUuid,
          providerId: body.providerId,
          type: body.source,
          title,
          originalTitle: showData.originalTitle,
          romanizedTitle: showData.romanizedTitle,
          metadata: showData.metadata,
          profile: body.profile,
          showProfileId: body.showProfileId,
          seriesType,
          config: {},
          rootFolderPath: body.rootFolderPath,
        });

        // Full sync (metadata + episodes + air dates) so the show isn't
        // empty the moment it shows up in the library grid. Delegates to
        // SyncManager so the add-flow and scheduled sync never drift apart.
        // We run this in the background to avoid freezing the UI.
        new SyncManager(config).syncShow(showUuid).catch(syncErr => {
          console.warn(`[api] initial sync failed for "${title}":`, syncErr);
        });

        return json({ id: showUuid, providerType: body.source, title }, { status: 201 });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/bulk-delete": {
    async POST(req: RouteReq) {
      try {
        const { ids } = await req.json() as { ids: string[] };
        if (!Array.isArray(ids) || ids.length === 0) {
          return errorResponse("ids array is required.");
        }
        for (const id of ids) {
          const show = db.getShow(id);
          if (show) {
            db.logEvent({
              type: 'delete',
              entityType: 'show',
              entityId: id,
              message: `Removed show "${show.title}"`,
            });
          }
        }
        db.removeShows(ids);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id": {
    async GET(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        if (!show) return errorResponse("Show not found.", 404);

        const config = db.getShowConfig(req.params.id!);

        return json({
          id: show.id,
          providerType: show.provider_type,
          title: show.title,
          profile: show.profile,
          year: show.year,
          originalTitle: show.original_title,
          rootFolderPath: show.root_folder_path,
          seriesType: show.series_type ?? 'standard',
          lastUpdated: show.last_updated,
          config,
        });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async PATCH(req: RouteReq) {
      try {
        const body = (await req.json()) as { profile?: string; title?: string; rootFolderPath?: string; seriesType?: string; config?: Record<string, any> };
        db.updateShow(req.params.id!, body);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    async DELETE(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        db.removeShow(req.params.id!);
        db.logEvent({
          type: 'delete',
          entityType: 'show',
          entityId: req.params.id!,
          message: `Removed show "${show?.title ?? 'unknown'}"`,
        });
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id/relocate": {
    async POST(req: RouteReq) {
      try {
        const { newRootPath } = await req.json() as { newRootPath: string };
        const showId = req.params.id!;
        const show = db.getShow(showId);
        if (!show) return errorResponse("Show not found", 404);
        const oldRoot = show.rootFolderPath;
        if (!oldRoot) return errorResponse("Show has no root folder set", 400);

        const episodes = db.listShowEpisodes(showId);
        const results: { season: number; episode: number; ok: boolean; error?: string }[] = [];

        for (const ep of episodes) {
          if (!ep.file_path) continue;
          const relative = ep.file_path.startsWith(oldRoot)
            ? ep.file_path.slice(oldRoot.length).replace(/^\//, '')
            : path.basename(ep.file_path);
          const newPath = path.posix ? path.posix.join(newRootPath, relative) : path.join(newRootPath, relative);

          const dir = path.dirname(newPath);
          await fs.promises.mkdir(dir, { recursive: true });

          try {
            await fs.promises.rename(ep.file_path, newPath);
          } catch (err: any) {
            if (err.code === 'EXDEV') {
              await fs.promises.copyFile(ep.file_path, newPath);
              await fs.promises.unlink(ep.file_path);
            } else {
              results.push({ season: ep.season_number, episode: ep.episode_number, ok: false, error: err.message });
              continue;
            }
          }
          db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, newPath);
          results.push({ season: ep.season_number, episode: ep.episode_number, ok: true });
        }

        return json({ ok: true, moved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id/organize": {
    async POST(req: RouteReq) {
      try {
        const showId = req.params.id!;
        const show = db.getShow(showId);
        if (!show) return errorResponse("Show not found", 404);

        const episodes = db.listShowEpisodes(showId);
        const results: { season: number; episode: number; ok: boolean; skipped?: boolean; error?: string }[] = [];

        for (const ep of episodes) {
          if (!ep.file_path) continue;
          const ext = path.extname(ep.file_path);
          const dir = path.dirname(ep.file_path);
          const newName = `${show.title} - S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}${ext}`;
          const newPath = path.join(dir, newName);

          if (newPath === ep.file_path) {
            results.push({ season: ep.season_number, episode: ep.episode_number, ok: true, skipped: true });
            continue;
          }

          try {
            await fs.promises.rename(ep.file_path, newPath);
            db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, newPath);
            results.push({ season: ep.season_number, episode: ep.episode_number, ok: true });
          } catch (err: any) {
            results.push({ season: ep.season_number, episode: ep.episode_number, ok: false, error: err.message });
          }
        }

        return json({ ok: true, renamed: results.filter(r => r.ok && !r.skipped).length, skipped: results.filter(r => r.skipped).length, failed: results.filter(r => !r.ok).length, results });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Seasons / Episodes ---------------------------------------------
  // There's no populated `seasons` table yet (nothing calls db.saveSeason
  // in the current backend), so seasons are derived here from the
  // episodes table, which sync/add does populate.

  "/api/shows/:id/seasons": {
    async GET(req: RouteReq) {
      try {
        const episodes = db.listAllEpisodes(req.params.id!);
        const bySeason = new Map<number, { episodeCount: number; trackedCount: number }>();
        for (const ep of episodes) {
          const entry = bySeason.get(ep.season_number) ?? { episodeCount: 0, trackedCount: 0 };
          entry.episodeCount += 1;
          if (ep.is_tracked) entry.trackedCount += 1;
          bySeason.set(ep.season_number, entry);
        }
        const seasons = [...bySeason.entries()]
          .sort(([a], [b]) => {
            if (a === 0) return 1;
            if (b === 0) return -1;
            return a - b;
          })
          .map(([seasonNumber, stats]) => ({ seasonNumber, ...stats }));
        return json(seasons);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id/seasons/:season/episodes": {
    async GET(req: RouteReq) {
      try {
        const seasonNumber = parseInt(req.params.season!, 10);
        const episodes = db.listEpisodes(req.params.id!, seasonNumber);
        return json(
          episodes.map((e: any) => ({
            season: e.season_number,
            episode: e.episode_number,
            absoluteNumber: e.absolute_number,
            title: e.title,
            filePath: e.file_path,
            tracked: !!e.is_tracked,
            airDate: e.air_date || null,
            searchMode: e.search_mode || 'auto',
          })),
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id/seasons/:season/episodes/:episode/grab": {
    async POST(req: RouteReq) {
      try {
        const config = loadConfig();
        const grabber = new GrabberService(config);
        const season = parseInt(req.params.season!, 10);
        const episode = parseInt(req.params.episode!, 10);
        const result = await grabber.grabBestRelease(req.params.id!, season, episode);
        return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // Auto-grabs the single best release for an entire season (season packs
  // included), scored against the show's assigned quality profile.
  "/api/shows/:id/seasons/:season/grab": {
    async POST(req: RouteReq) {
      try {
        const config = loadConfig();
        const grabber = new GrabberService(config);
        const season = parseInt(req.params.season!, 10);
        const result = await grabber.grabBestSeasonRelease(req.params.id!, season);
        return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // Interactive search: returns every scored release found for a season
  // (packs and individual episodes both come back from Prowlarr for a
  // season-level query), letting the person pick exactly which one to grab
  // via POST /api/search/grab.
  "/api/shows/:id/seasons/:season/search": {
    async GET(req: RouteReq) {
      try {
        const config = loadConfig();
        const grabber = new GrabberService(config);
        const season = parseInt(req.params.season!, 10);
        const result = await grabber.searchReleases(req.params.id!, season);
        if ("error" in result) return errorResponse(result.error, 400);
        return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  // ---- Indexer management / search ---------------------------------------

  "/api/indexers/prowlarr/status": {
    async GET() {
      try {
        const indexer = getProwlarrIndexer();
        if (!indexer) return json({ ok: false, message: "Prowlarr not configured" });
        const result = await indexer.validate();
        return json(result);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/indexers/prowlarr/indexers": {
    async GET() {
      try {
        const indexer = getProwlarrIndexer();
        if (!indexer) return json({ ok: false, message: "Prowlarr not configured" });
        const indexers = await indexer.listIndexers();
        return json(indexers);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/indexers/native/meta": {
    async GET() {
      try {
        return json(
          Object.entries(NATIVE_INDEXER_META).map(([id, meta]) => ({
            id,
            ...meta,
          }))
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/indexers/native/status": {
    async GET() {
      try {
        const natives = getNativeIndexers();
        const results = await Promise.all(
          natives.map(async ({ config, instance }) => {
            const status = await instance.validate();
            return { id: config.id, name: instance.name, ...status };
          })
        );
        return json(results);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/indexers/native/test/:id": {
    async GET(req: RouteReq) {
      try {
        const rawId = req.params.id!;
        if (!rawId || !(rawId in NATIVE_INDEXER_META)) {
          return errorResponse(`Unknown native indexer: ${rawId}`, 400);
        }
        const id = rawId as NativeIndexerId;
        const raw = db.getSetting('nativeIndexers');
        const configs: NativeIndexerConfig[] = raw ? JSON.parse(typeof raw === 'string' ? raw : raw) : [];
        const cfg = configs.find(c => c.id === id);
        const instance = IndexerFactory.createNative(cfg ?? { id, enabled: true });
        const result = await instance.validate();
        return json(result);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  // ---- Sonarr Import ----------------------------------------------------

  "/api/sonarr/settings": {
    async GET() {
      try {
        const raw = db.getSetting('sonarr');
        if (!raw) return json({ enabled: false, baseUrl: '', apiKey: '' });
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const config = SonarrConfigSchema.parse(parsed);
        return json({ ...config, apiKey: config.apiKey ? '********' : '' });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = await req.json() as Record<string, any>;
        const existing = db.getSetting('sonarr');
        let merged = body;
        if (existing) {
          try {
            const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
            merged = { ...parsed, ...body };
          } catch { }
        }
        const result = SonarrConfigSchema.safeParse(merged);
        if (!result.success) {
          return errorResponse(result.error.issues.map(i => i.message).join("; "));
        }
        db.setSetting('sonarr', result.data);
        invalidateConfigCache();
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/sonarr/test": {
    async GET() {
      try {
        const client = getSonarrClient();
        if (!client) return json({ ok: false, message: "Sonarr not configured" });
        const result = await client.test();
        return json(result);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/sonarr/series": {
    async GET() {
      try {
        const client = getSonarrClient();
        if (!client) return json({ ok: false, message: "Sonarr not configured" });
        const series = await client.getSeries();
        return json(series);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/sonarr/import": {
    async POST(req: RouteReq) {
      try {
        const raw = db.getSetting('sonarr');
        if (!raw) return errorResponse("Sonarr not configured", 400);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const config = SonarrConfigSchema.parse(parsed);
        if (!config.enabled || !config.baseUrl || !config.apiKey) {
          return errorResponse("Sonarr is not fully configured", 400);
        }

        const body = await req.json() as { seriesIds?: number[]; typeMapping?: SonarrTypeMapping } | undefined;
        const appConfig = loadConfig();
        const importer = new SonarrImporter(config.baseUrl, config.apiKey, config.apiVersion ?? 'v3', appConfig);

        // Run import in background, return immediately
        const importPromise = importer.importSeries(body?.seriesIds, body?.typeMapping);

        // For small imports, wait for result; for large ones, fire and forget
        const series = body?.seriesIds;
        if (!series || series.length <= 5) {
          const results = await importPromise;
          return json({ results });
        }

        // Fire and forget for large imports
        importPromise.then(results => {
          console.log(`[sonarr] Import completed: ${results.filter(r => r.status === 'imported').length} imported, ${results.filter(r => r.status === 'existing').length} existing, ${results.filter(r => r.status === 'error').length} errors`);
        }).catch(err => {
          console.error('[sonarr] Import failed:', err);
        });

        return json({ message: `Import started for ${series.length} series. Check server logs for results.` });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Jellyfin Sync ---------------------------------------------------

  "/api/jellyfin/settings": {
    async GET() {
      try {
        const raw = db.getSetting('jellyfin');
        if (!raw) return json({ enabled: false, baseUrl: '', apiKey: '' });
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const config = JellyfinConfigSchema.parse(parsed);
        return json({ ...config, apiKey: config.apiKey ? '********' : '' });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const body = await req.json() as Record<string, any>;
        const existing = db.getSetting('jellyfin');
        let merged = body;
        if (existing) {
          try {
            const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
            merged = { ...parsed, ...body };
          } catch { }
        }
        const result = JellyfinConfigSchema.safeParse(merged);
        if (!result.success) {
          return errorResponse(result.error.issues.map(i => i.message).join("; "));
        }
        db.setSetting('jellyfin', result.data);
        invalidateConfigCache();
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/jellyfin/test": {
    async GET() {
      try {
        const client = getJellyfinClient();
        if (!client) return json({ ok: false, message: "Jellyfin not configured" });
        const result = await client.test();
        return json(result);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/jellyfin/users": {
    async GET() {
      try {
        const client = getJellyfinClient();
        if (!client) return json({ ok: false, message: "Jellyfin not configured" });
        const users = await client.getUsers();
        return json(users.map(u => ({ id: u.Id, name: u.Name, isAdmin: u.IsAdministrator })));
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/jellyfin/sync": {
    async POST(req: RouteReq) {
      try {
        const raw = db.getSetting('jellyfin');
        if (!raw) return errorResponse("Jellyfin not configured", 400);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const config = JellyfinConfigSchema.parse(parsed);
        if (!config.enabled || !config.baseUrl || !config.apiKey) {
          return errorResponse("Jellyfin is not fully configured", 400);
        }

        const syncer = new JellyfinSync(config.baseUrl, config.apiKey);
        const result = await syncer.sync();
        return json(result);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/search": {
    async GET(req: RouteReq) {
      try {
        const url = new URL(req.url);
        const query = url.searchParams.get("q");
        if (!query || query.trim().length === 0) return json([]);

        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const categories = url.searchParams.getAll("category").map(c => parseInt(c, 10)).filter(c => !Number.isNaN(c));
        const type = (url.searchParams.get("type") as "search" | "tvsearch" | "movie" | "music" | "book" | null) ?? undefined;

        const allResults: IndexerResult[] = [];

        const prowlarr = getProwlarrIndexer();
        if (prowlarr) {
          try {
            const results = await prowlarr.search(query, { categories: categories.length ? categories : undefined, type });
            allResults.push(...results);
          } catch (e) {
            console.error('[api] Prowlarr search error:', e);
          }
        }

        const natives = getNativeIndexers();
        await Promise.all(natives.map(async ({ instance }) => {
          try {
            const results = await instance.search(query, { categories: categories.length ? categories : undefined, type });
            allResults.push(...results);
          } catch (e) {
            console.error(`[api] Native indexer ${instance.name} search error:`, e);
          }
        }));

        const sliced = allResults.slice(0, Number.isNaN(limit) ? 50 : limit);
        return json(sliced);
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  // Grabs a specific release the person picked from `/api/search` results
  // (interactive search), as opposed to GrabberService's fully-automatic
  // "find and grab the best one" flow used by the per-episode grab route.
  // When TorBox is configured, releases go directly to it instead of writing
  // .torrent/.magnet files to a blackhole folder.
  "/api/search/grab": {
    async POST(req: RouteReq) {
      try {
        const release = await req.json();
        if (!release?.guid) {
          return errorResponse("A full release object (as returned by /api/search) is required.");
        }

        let ok = false;
        let message: string | undefined;

        const torbox = systemManager.getWatcher()?.getTorboxClient();
        if (torbox) {
          const result = await torbox.submitReleaseBackground(release);
          ok = result.ok;
          message = result.message;
        } else {
          const prowlarr = getProwlarrIndexer();
          if (prowlarr) {
            ok = await prowlarr.grab(release);
          }
          if (!ok) {
            const natives = getNativeIndexers();
            const match = natives.find(n => release.indexerName === n.instance.name)?.instance;
            if (match) {
              ok = await match.grab(release);
            }
          }
        }

        if (ok) {
          db.logEvent({ type: "grab", entityType: "release", message: message || `Grabbed ${release.title}` });
        }
        return json({ success: ok, message: message || (ok ? `Grabbed ${release.title}` : `Grab failed for "${release.title}". Check that a Download Client is configured.`) });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/shows/:id/sync": {
    async POST(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        if (!show) return errorResponse("Show not found.", 404);
        await new SyncManager(loadConfig()).syncShow(req.params.id!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/sync-all": {
    async POST(req: RouteReq) {
      try {
        const body = await req.json().catch(() => ({})) as { force?: boolean };
        const syncManager = new SyncManager(loadConfig());
        const result = await syncManager.syncAllShows(body.force ?? true); // Default to force for manual sync
        return json({ ok: true, ...result });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/shows/:id/scan": {
    async POST(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        if (!show) return errorResponse("Show not found.", 404);
        await systemManager.scanShow(req.params.id!);
        db.logEvent({
          type: 'scan',
          entityType: 'show',
          entityId: req.params.id!,
          message: `Scanned show "${show.title}"`,
        });
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Provider management ----------------------------------------------

  "/api/shows/:id/providers": {
    async GET(req: RouteReq) {
      try {
        const providers = db.listShowProvidersWithRoles(req.params.id!);
        return json(providers.map(p => ({
          type: p.provider_type,
          id: p.provider_id,
          title: p.title,
          isPrimary: !!p.is_primary,
          lastSynced: p.last_synced,
          roles: p.roles,
        })));
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    async POST(req: RouteReq) {
      try {
        const { providerType, providerId } = await req.json();
        if (!providerType || !providerId) {
          return errorResponse("providerType and providerId are required");
        }
        db.addShowProvider(req.params.id!, providerType, providerId);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/providers/:type": {
    async DELETE(req: RouteReq) {
      try {
        db.removeShowProvider(req.params.id!, req.params.type!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/providers/:type/primary": {
    async PUT(req: RouteReq) {
      try {
        db.setPrimaryProvider(req.params.id!, req.params.type!);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/providers/:type/role": {
    async PUT(req: RouteReq) {
      try {
        const { role, active } = await req.json();
        if (!role || !['metadata', 'airtime'].includes(role)) {
          return errorResponse("role must be 'metadata' or 'airtime'");
        }
        db.setProviderRole(req.params.id!, req.params.type!, role as 'metadata' | 'airtime', !!active);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/seasons/:season/tracked": {
    async PATCH(req: RouteReq) {
      try {
        const body = (await req.json()) as { tracked: boolean };
        const showId = req.params.id!;
        const seasonNumber = parseInt(req.params.season!, 10);
        const episodes = db.listEpisodes(showId, seasonNumber);
        episodes.forEach(e => db.setTracked(showId, e.season_number, e.episode_number, !!body.tracked));
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/seasons/:season/episodes/:episode/tracked": {
    async PATCH(req: RouteReq) {
      try {
        const { tracked } = await req.json();
        db.setTracked(req.params.id!, parseInt(req.params.season!, 10), parseInt(req.params.episode!, 10), !!tracked);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  "/api/shows/:id/seasons/:season/episodes/:episode/search": {
    // Interactive search: returns every scored release found for this
    // specific episode, letting the person pick which one to grab via
    // POST /api/search/grab.
    async GET(req: RouteReq) {
      try {
        const config = loadConfig();
        const grabber = new GrabberService(config);
        const season = parseInt(req.params.season!, 10);
        const episode = parseInt(req.params.episode!, 10);
        const result = await grabber.searchReleases(req.params.id!, season, episode);
        if ("error" in result) return errorResponse(result.error, 400);
        return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
    async PATCH(req: RouteReq) {
      try {
        const { mode } = await req.json();
        if (mode !== 'auto' && mode !== 'interactive') return errorResponse("mode must be 'auto' or 'interactive'");
        db.updateEpisodeSearchMode(req.params.id!, parseInt(req.params.season!, 10), parseInt(req.params.episode!, 10), mode);
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },

  // ---- Providers (search, for the Add Show flow) -----------------------

  "/api/providers/:source/search": {
    async GET(req: RouteReq) {
      try {
        const source = req.params.source!;
        if (!isProviderType(source)) {
          return errorResponse(`Unknown source "${source}".`);
        }
        const url = new URL(req.url);
        const q = url.searchParams.get("q");
        if (!q || q.trim().length === 0) return json([]);

        const config = loadConfig();
        const provider = ProviderFactory.getProvider(source, config);
        const results = await provider.searchShow(q);
        return json(
          results.slice(0, 12).map((r) => {
            const existing = db.getShowByProvider(source, r.id);
            const meta = r.metadata as Record<string, any> | undefined;
            let originalTitle = r.originalTitle;
            let romanizedTitle = r.romanizedTitle;
            // Extract alternate titles from provider metadata if not already mapped
            if (!originalTitle && meta) {
              if (source === "tmdb") originalTitle = meta.original_name;
              else if (source === "anilist") {
                originalTitle = meta.title?.native;
                romanizedTitle = romanizedTitle ?? meta.title?.romaji;
              }
            }
            return {
              id: r.id,
              title: r.title,
              originalTitle: originalTitle ?? null,
              romanizedTitle: romanizedTitle ?? null,
              year: r.year,
              providerType: source,
              posterUrl: `/api/images/poster/${source}/${r.id}`,
              existingShowId: existing?.id || null,
              overview: source === "tmdb" ? meta?.overview : source === "anilist" ? meta?.description : null,
              type: source === "anilist" ? meta?.format : null,
            };
          }),
        );
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  // ---- Show UUID image proxy --------------------------------------------

  "/api/shows/:id/images/poster": {
    async GET(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        if (!show) return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });

        // Check DB blob cache first
        const cached = db.getShowArtworks(show.id, 2) as any[];
        if (cached.length > 0 && cached[0].data) {
          const contentType = cached[0].content_type ?? "image/jpeg";
          const cacheControl = `public, max-age=${cached[0].image_url ? 86400 : 3600}`;
          return new Response(cached[0].data, { headers: { "Content-Type": contentType, "Cache-Control": cacheControl } });
        }

        const config = loadConfig();
        const provider = ProviderFactory.getProvider(show.provider_type, config);
        const showData = await provider.getShow(show.provider_id);
        const posterUrl = extractPosterUrl(show.provider_type, showData.metadata);

        if (!posterUrl) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }

        const imgRes = await fetch(posterUrl);
        if (!imgRes.ok) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }

        // Cache image bytes in DB for future requests
        const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
        const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
        db.saveShowArtwork(show.id, 2, posterUrl, undefined, undefined, undefined, imgBytes, contentType);

        return new Response(imgBytes, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=21600",
          },
        });
      } catch (err) {
        console.warn(`[api] poster fetch failed for show ${req.params.id!}:`, err);
        return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
      }
    },
  },

  "/api/shows/:id/images/backdrop": {
    async GET(req: RouteReq) {
      try {
        const show = db.getShow(req.params.id!);
        if (!show) return new Response('', { status: 404 });

        // Check DB blob cache first (artwork type 3 or 15)
        const cached = db.getShowArtworks(show.id) as any[];
        const backdropArt = cached.find(a => (a.artwork_type === "3" || a.artwork_type === "15") && a.data);
        if (backdropArt) {
          const contentType = backdropArt.content_type ?? "image/jpeg";
          return new Response(backdropArt.data, {
            headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
          });
        }

        const config = loadConfig();
        const provider = ProviderFactory.getProvider(show.provider_type, config);

        let backdropUrl: string | null = null;
        let artType = 0;

        if (show.provider_type === "tvdb") {
          const tvdb = provider as TVDBProvider;
          for (const at of [3, 15]) {
            const artworks = await tvdb.getSeriesArtworks(show.provider_id, at);
            const art = artworks[0];
            if (art?.image) {
              backdropUrl = art.image;
              artType = at;
              db.saveShowArtwork(show.id, at, art.image,
                art.width ?? undefined,
                art.height ?? undefined,
                art.thumbnail ?? undefined,);
              break;
            }
          }
        }

        if (!backdropUrl) {
          const showData = await provider.getShow(show.provider_id);
          backdropUrl = extractBackdropUrl(show.provider_type, showData.metadata);
        }

        if (!backdropUrl) return new Response('', { status: 404 });

        const imgRes = await fetch(backdropUrl);
        if (!imgRes.ok) return new Response('', { status: 404 });

        // Cache image bytes
        const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
        const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
        if (artType) db.saveShowArtwork(show.id, artType, backdropUrl, undefined, undefined, undefined, imgBytes, contentType);

        return new Response(imgBytes, {
          headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" },
        });
      } catch {
        return new Response('', { status: 404 });
      }
    },
  },

  // ---- Poster proxy -----------------------------------------------------
  // Keeps provider API keys server-side and sidesteps CORS. Relies on
  // BaseProvider's own metadata_cache (6h TTL) so repeated grid renders
  // don't hammer the upstream API.

  "/api/images/poster/:source/:id": {
    async GET(req: RouteReq) {
      const source = req.params.source!;
      if (!isProviderType(source)) {
        return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
      }
      try {
        const config = loadConfig();
        const provider = ProviderFactory.getProvider(source, config);
        const show = await provider.getShow(req.params.id!);
        const posterUrl = extractPosterUrl(source, show.metadata);

        if (!posterUrl) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }

        const imgRes = await fetch(posterUrl);
        if (!imgRes.ok) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }

        return new Response(imgRes.body, {
          headers: {
            "Content-Type": imgRes.headers.get("Content-Type") ?? "image/jpeg",
            "Cache-Control": "public, max-age=21600", // 6h, matches metadata_cache TTL
          },
        });
      } catch (err) {
        console.warn(`[api] poster fetch failed for ${source}/${req.params.id!}:`, err);
        return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
      }
    },
  },

  "/api/images/backdrop/:source/:id": {
    async GET(req: RouteReq) {
      const source = req.params.source!;
      if (!isProviderType(source)) {
        return new Response('', { status: 404 });
      }
      const showId = req.params.id!;
      try {
        const config = loadConfig();
        const provider = ProviderFactory.getProvider(source, config);

        let backdropUrl: string | null = null;

        // For TVDB, try the artworks API for widescreen backgrounds (type 3 or 15)
        if (source === "tvdb") {
          const tvdb = provider as TVDBProvider;
          for (const artType of [3, 15]) {
            const artworks = await tvdb.getSeriesArtworks(showId, artType);
            const art = artworks[0];
            if (art?.image) {
              backdropUrl = art.image;
              db.saveShowArtwork(showId, artType, art.image,
                art.width ?? undefined,
                art.height ?? undefined,
                art.thumbnail ?? undefined,);
              break;
            }
          }
        }

        // Fallback to metadata-based extraction for all providers
        if (!backdropUrl) {
          const show = await provider.getShow(showId);
          backdropUrl = extractBackdropUrl(source, show.metadata);
        }

        if (!backdropUrl) {
          return new Response('', { status: 404 });
        }

        const imgRes = await fetch(backdropUrl);
        if (!imgRes.ok) {
          return new Response('', { status: 404 });
        }

        const imgBuffer = await imgRes.arrayBuffer();
        const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
        db.saveShowArtwork(showId, 15, backdropUrl, undefined, undefined, undefined, new Uint8Array(imgBuffer), contentType);

        return new Response(imgBuffer, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=21600",
          },
        });
      } catch {
        return new Response('', { status: 404 });
      }
    },
  },

  // ---- Artwork proxy (TVDB artwork types) --------------------------------
  // Fetches provider-specific artwork (banner, fanart, poster) by type ID,
  // caches the metadata in the DB and the image bytes on disk.

  "/api/images/artwork/:source/:id/:type": {
    async GET(req: RouteReq) {
      const source = req.params.source!;
      if (!isProviderType(source)) {
        return new Response('', { status: 404 });
      }
      const type = parseInt(req.params.type!, 10);
      if (Number.isNaN(type)) {
        return new Response('', { status: 400 });
      }

      const showId = req.params.id!;
      try {
        const config = loadConfig();
        const provider = ProviderFactory.getProvider(source, config);

        // Check DB for cached artwork data
        const existing = db.getShowArtworks(showId, type);
        const cached = existing[0];

        if (cached?.data) {
          return new Response(cached.data, {
            headers: {
              "Content-Type": cached.content_type ?? "image/jpeg",
              "Cache-Control": "public, max-age=86400",
            },
          });
        }

        // Try provider-specific artwork endpoint first
        if (source === "tvdb") {
          const tvdb = provider as TVDBProvider;
          let artworks = existing;
          if (artworks.length === 0) {
            try {
              const seriesArtworks = await tvdb.getSeriesArtworks(showId, type);
              for (const art of seriesArtworks) {
                db.saveShowArtwork(showId, art.type, art.image,
                  art.width ?? undefined,
                  art.height ?? undefined,
                  art.thumbnail ?? undefined,);
              }
              artworks = db.getShowArtworks(showId, type);
            } catch (e) {
              console.warn(`[api] tvdb getSeriesArtworks failed:`, e);
            }
          }
          const artwork = artworks[0];
          if (artwork?.image_url) {
            const imgRes = await fetch(artwork.image_url);
            if (imgRes.ok) {
              const imgBuffer = await imgRes.arrayBuffer();
              const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
              db.saveShowArtwork(showId, type, artwork.image_url, artwork.width, artwork.height, artwork.thumbnail, new Uint8Array(imgBuffer), contentType);
              return new Response(imgBuffer, {
                headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
              });
            }
          }
        }

        // Fallback: extract backdrop/poster from show metadata (works for all providers)
        const show = await provider.getShow(showId);
        let imgUrl: string | null = null;
        if (type === 2) {
          imgUrl = extractBackdropUrl(source, show.metadata);
        }
        if (!imgUrl) {
          imgUrl = extractPosterUrl(source, show.metadata);
        }
        if (!imgUrl) return new Response('', { status: 404 });

        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) return new Response('', { status: 404 });

        const imgBuffer = await imgRes.arrayBuffer();
        const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
        db.saveShowArtwork(showId, type, imgUrl, undefined, undefined, undefined, new Uint8Array(imgBuffer), contentType);

        return new Response(imgBuffer, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=21600",
          },
        });
      } catch (err) {
        console.warn(`[api] artwork fetch failed for ${source}/${showId}/${type}:`, err);
        return new Response('', { status: 404 });
      }
    },
  },

  // ---- Backup ------------------------------------------------------------
  "/api/backup": {
    GET: async () => {
      try {
        const entries = await listBackups();
        return json(entries);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
    POST: async () => {
      try {
        const result = await runBackup();
        db.logEvent({ type: 'backup', message: `Backup created: ${result.dbFile}` });
        const entries = await listBackups();
        return json({ ...result, entries });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },
  "/api/backups/upload": {
    POST: async (req: RouteReq) => {
      try {
        const form = await req.formData();
        const file = form.get("file") as File | null;
        if (!file) return new Response("No file provided", { status: 400 });

        const buf = await file.bytes();
        const entry = await uploadBackup(buf, file.name);
        return json(entry);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },
  "/api/backups/:file/restore": {
    POST: async (req: RouteReq) => {
      try {
        const file = req.params.file!;
        await restoreBackup(file, 'showflow.db');
        db.reload();
        db.logEvent({ type: 'restore', message: `Database restored from backup: ${file}` });
        return json({ ok: true });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },
  "/api/backups/:file": {
    GET(req: RouteReq) {
      const p = path.join(process.cwd(), "backups", req.params.file!);
      if (fs.existsSync(p)) {
        return new Response(Bun.file(p));
      }
      return new Response("", { status: 404 });
    },
  },

  // ---- Calendar -----------------------------------------------------------
  // Reads straight from the synced episodes table (air_date, populated by
  // SyncManager) - no live provider calls on this path.

  "/api/files/browse": {
    GET(req: RouteReq) {
      try {
        const url = new URL(req.url);
        const rawPath = url.searchParams.get("path") || "/";
        const dirPath = path.resolve(rawPath);
        if (!fs.existsSync(dirPath)) return json({ error: "Path does not exist" }, { status: 404 });
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) return json({ error: "Path is not a directory" }, { status: 400 });
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const directories = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b));
        const parentPath = path.dirname(dirPath);
        return json({
          path: dirPath,
          directories,
          parentPath: parentPath === dirPath ? null : parentPath,
        });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/calendar": {
    async GET(req: RouteReq) {
      try {
        const url = new URL(req.url);
        const days = parseInt(url.searchParams.get("days") ?? "7", 10);
        const past = parseInt(url.searchParams.get("past") ?? "0", 10);
        const episodes = db.listUpcomingEpisodes(Number.isNaN(days) ? 7 : days, Number.isNaN(past) ? 0 : past);
        return json(
          episodes.map((ep: any) => ({
            showId: ep.show_id,
            showTitle: ep.show_title,
            episodeTitle: ep.title,
            season: ep.season_number,
            episode: ep.episode_number,
            airDate: ep.air_date,
            filePath: ep.file_path ?? null,
          })),
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/missing": {
    async GET() {
      try {
        const episodes = db.listMissingEpisodes();
        return json(
          episodes.map((ep: any) => ({
            showId: ep.show_id,
            showTitle: ep.show_title,
            episodeTitle: ep.title,
            season: ep.season_number,
            episode: ep.episode_number,
            airDate: ep.air_date,
            searchMode: ep.search_mode || 'auto',
          })),
        );
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/feedback": {
    async POST(req: RouteReq) {
      try {
        const body = (await req.json()) as {
          message: string;
          screenshot?: string;
          url?: string;
          includeDebugLogs?: boolean;
          userAgent?: string;
        };

        if (!body.message?.trim()) {
          return errorResponse("Message is required");
        }

        const token = process.env.GITHUB_TOKEN;
        const repo = process.env.GITHUB_REPO;

        if (!token || !repo) {
          return errorResponse("Feedback is not configured — set GITHUB_TOKEN and GITHUB_REPO environment variables", 501);
        }

        const lines = [
          `**Description**`,
          body.message,
          "",
          `**URL**  ${body.url || "N/A"}`,
          `**Browser**  ${body.userAgent || "N/A"}`,
          `**Time**  ${new Date().toISOString()}`,
        ];

        if (body.screenshot) {
          lines.push("", "**Screenshot**", `![screenshot](data:image/png;base64,${body.screenshot})`);
        }

        if (body.includeDebugLogs) {
          const logs = getDebugLogs({ limit: 50 });
          if (logs.length > 0) {
            lines.push("", "**Debug Logs**", "```", JSON.stringify(logs, null, 2).slice(0, 8000), "```");
          }
        }

        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "showflow-feedback",
          },
          body: JSON.stringify({
            title: `Feedback: ${body.message.slice(0, 80)}${body.message.length > 80 ? "…" : ""}`,
            body: lines.join("\n"),
            labels: ["feedback"],
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          console.error("[feedback] GitHub API error:", res.status, err);
          return errorResponse(`GitHub API error: ${res.status}`, 502);
        }

        const issue = await res.json();
        return json({ url: issue.html_url, number: issue.number });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  // ---- Manual Import ----------------------------------------------------
  // Lists files sitting in the watch folder that haven't been imported yet,
  // and allows force-importing them while bypassing the upgrade check.

  "/api/manual-import/list": {
    async GET() {
      try {
        const files = await systemManager.listManualImportFiles();
        return json(files);
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/manual-import/import": {
    async POST(req: RouteReq) {
      try {
        const body = (await req.json()) as { files: string[] };
        if (!Array.isArray(body.files) || body.files.length === 0) {
          return errorResponse('files array is required');
        }
        const results = [];
        for (const filename of body.files) {
          const result = await systemManager.forceImportFile(filename);
          results.push({ filename, ...result });
        }
        return json({ results });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/manual-import/delete": {
    async POST(req: RouteReq) {
      try {
        const body = (await req.json()) as { files: string[] };
        if (!Array.isArray(body.files) || body.files.length === 0) {
          return errorResponse('files array is required');
        }
        const results = [];
        for (const filename of body.files) {
          const result = await systemManager.deleteWatchFile(filename);
          results.push({ filename, ...result });
        }
        return json({ results });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/manual-import/count": {
    async GET() {
      try {
        const count = await systemManager.countWatchFiles();
        return json({ count });
      } catch (err) {
        return errorResponse(err, 500);
      }
    },
  },

  "/api/debug/logs": {
    GET(req: RouteReq) {
      const url = new URL(req.url);
      const type = url.searchParams.get('type') || undefined;
      const level = url.searchParams.get('level') || undefined;
      const method = url.searchParams.get('method') || undefined;
      const path = url.searchParams.get('path') || undefined;
      const search = url.searchParams.get('search') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      const since = url.searchParams.get('since') || undefined;
      return json(getDebugLogs({ type: type as any, level: level as any, method, path, search, since, limit: Number.isNaN(limit) ? undefined : limit }));
    },
  },
  "/api/debug/clear": {
    POST() {
      clearDebugLogs();
      return json({ ok: true });
    },
  },
  "/api/debug/ws": {
    GET(req: RouteReq, server: any) {
      if (server.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    },
  },

  // ---- Admin token (unauthenticated - exposes the persisted token to the
  // frontend so it never needs manual entry) --------------------------------
  "/api/admin/token": {
    GET() {
      return json({ token: ADMIN_TOKEN });
    },
  },

  // ---- Updates / Release management --------------------------------------
  // Bridges the supervisor's loopback-only admin API (127.0.0.1:9090, no
  // auth of its own — see supervisor/index.ts) out to a public, token-
  // authenticated surface. The admin token is generated once on first boot
  // and persisted to the database — see checkAdminAuth() above.

  "/api/admin/updates/available": {
    async GET(req: RouteReq) {
      if (!checkAdminAuth(req)) return unauthorized();
      try {
        const url = new URL(req.url);
        const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
        const result = await listReleases(BUILD_VERSION, page);
        return json({ current: { releaseId: BUILD_COMMIT, version: BUILD_VERSION }, ...result });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/admin/updates/install": {
    async POST(req: RouteReq) {
      if (!checkAdminAuth(req)) return unauthorized();
      try {
        const { githubReleaseId } = (await req.json()) as { githubReleaseId?: number };
        if (!githubReleaseId) return errorResponse("githubReleaseId is required");
        const result = await downloadAndInstall(githubReleaseId);
        db.logEvent({
          type: result.ok ? "update" : "error",
          entityType: "system",
          message: result.ok ? `Installed release "${result.releaseId}" \u2014 ready to activate` : `Install failed: ${result.message}`,
        });
        return json(result, { status: result.ok ? 200 : 400 });
      } catch (err) {
        db.logEvent({ type: "error", entityType: "system", message: `Update install failed: ${err instanceof Error ? err.message : String(err)}` });
        return errorResponse(err, 502);
      }
    },
  },

  // Fire-and-forget from this process's point of view — see the extensive
  // comment on triggerActivate() in core/updates_manager.ts for why: this
  // app process is what gets replaced, so it structurally cannot await the
  // supervisor's full activation response on the success path. The
  // frontend's job after calling this is polling /internal/ready per the
  // documented reconnect contract, not trusting this response as final.
  "/api/admin/updates/activate": {
    async POST(req: RouteReq) {
      if (!checkAdminAuth(req)) return unauthorized();
      try {
        const { releaseId } = (await req.json()) as { releaseId?: string };
        if (!releaseId) return errorResponse("releaseId is required");
        db.logEvent({ type: "update", entityType: "system", message: `Activation triggered for release "${releaseId}"` });
        const result = await triggerActivate(releaseId);
        return json(result, { status: result.ok ? 200 : 400 });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  "/api/admin/updates/status": {
    async GET(req: RouteReq) {
      if (!checkAdminAuth(req)) return unauthorized();
      try {
        const supervisor = await getSupervisorStatus();
        return json({ ...supervisor, appReleaseId: BUILD_COMMIT, appVersion: BUILD_VERSION });
      } catch (err) {
        return errorResponse(err, 502);
      }
    },
  },

  // ---- Readiness ---------------------------------------------------------
  // Proves DB health, not just process-up. The supervisor requires this to
  // pass several times in a row (see supervisor/index.ts) before treating a
  // release as stable — a process can answer once and then wedge.
  "/internal/ready": {
    async GET() {
      if (shuttingDown) {
        return json({ ready: false, error: "shutting down" }, { status: 503 });
      }
      try {
        db.drizz.get(sql`select 1`);
        return json({
          ready: true,
          releaseId: BUILD_COMMIT,
          version: BUILD_VERSION,
          database: "ready",
        });
      } catch (err) {
        return json({ ready: false, error: String(err) }, { status: 503 });
      }
    },
  },
};

function wrapRouteHandlers(defs: Record<string, any>): any {
  for (const [path, handlers] of Object.entries(defs)) {
    if (typeof handlers === 'object' && handlers !== null && !(handlers instanceof Response)) {
      if (path === "/*" || path === "/sw.js" || path === "/offline.html" || path.startsWith('/assets/') || path.startsWith('/api/debug') || path.startsWith('/internal/')) continue;
      for (const [method, handler] of Object.entries(handlers)) {
        if (typeof handler === 'function') {
          (handlers as Record<string, any>)[method] = wrapWithDebug(path, method.toUpperCase(), handler);
        }
      }
    }
  }
  return defs;
}

const server = serve({
  routes: wrapRouteHandlers(routeDefinitions),
  websocket: {
    open(ws: ServerWebSocket) {
      debugWsClients.add(ws as any);
      const unsub = subscribeDebugLogs((entry) => {
        try { (ws as any).send(JSON.stringify(entry)); } catch { }
      });
      (ws as any)._debugUnsub = unsub;
    },
    message(ws, message) {
      // Debug WebSocket is send-only — ignore incoming messages
    },
    close(ws: ServerWebSocket) {
      debugWsClients.delete(ws as any);
      if ((ws as any)._debugUnsub) (ws as any)._debugUnsub();
    },
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: false,
  },
});

const config = loadConfig();
const scheduler = new Scheduler(config);
scheduler.start();

const systemManager = new SystemManager(config);

console.log(`🚀 Server running at ${server.url} (release ${BUILD_COMMIT}, version ${BUILD_VERSION})`);

// ---- Graceful shutdown -------------------------------------------------
// `Subprocess.kill()` from the supervisor's side gives no drain guarantee
// on its own — this is the app's half of the stop-start handoff contract.
// The supervisor waits for the process to exit (or force-kills after its
// own deadline) before starting the candidate release, so db.close() below
// is what actually enforces single-writer ownership of showflow.db.
let sigtermReceived = false;
process.on("SIGTERM", async () => {
  if (sigtermReceived) return; // ignore repeat signals mid-shutdown
  sigtermReceived = true;

  shuttingDown = true; // 1. mark unready — /internal/ready now returns 503

  // 2. stop accepting new WebSocket subscribers implicitly (server keeps
  //    listening until process.exit, but…)
  // 3. …close existing debug WebSocket connections so clients reconnect
  //    against whatever comes up next rather than hanging on a dead pipe.
  for (const ws of debugWsClients) {
    try { (ws as any).close(1012, "server restarting"); } catch { }
  }

  // 6. stop background jobs/timers so nothing fires mid-teardown
  await scheduler.stop?.();

  // 7. checkpoint/close SQLite — must complete before this process exits,
  //    since the supervisor won't start the candidate until it does.
  db.close?.();

  // 8. exit
  process.exit(0);
});
