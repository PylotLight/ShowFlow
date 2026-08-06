// IMPORTANT: proxy-patch MUST be the first import — it patches globalThis.fetch
// during module evaluation, before any code that makes network calls can run.
import "./proxy-patch";

import { serve, type ServerWebSocket } from "bun";
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

import { db } from "./db";
import { Scheduler } from "./core/scheduler";
import { SystemManager } from "./core/system_manager";
import { subscribeDebugLogs, isDebugEnabled, createApiDebugLog } from "./core/debug";

import { configRoutes } from "./routes/config";
import { showRoutes } from "./routes/shows";
import { providerRoutes } from "./routes/providers";
import { searchRoutes } from "./routes/search";
import { imageRoutes } from "./routes/images";
import { systemRoutes } from "./routes/system";
import { integrationRoutes } from "./routes/integrations";
import { mediaManagementRoutes } from "./routes/media-management";
import { backupRoutes } from "./routes/backup";
import { debugRoutes } from "./routes/debug";
import { updateRoutes } from "./routes/updates";
import { miscRoutes } from "./routes/misc";
import { analyticsRoutes } from "./routes/analytics";
import { pipelineRoutes } from "./routes/pipeline";
import { backgroundJobRoutes } from "./routes/background-jobs";
import { notificationRoutes } from "./routes/notifications";
import { loadConfig, invalidateConfigCache, ADMIN_TOKEN } from "./routes/_shared";
import type { RouteReq } from "./routes/_shared";

// ---- Server lifecycle state ------------------------------------------------

const debugWsClients = new Set<WebSocket>();
let shuttingDown = false;

function isShuttingDown() {
  return shuttingDown;
}

// ---- Route definitions (composed from domain modules) -----------------------

const routeDefinitions: Record<string, any> = {
  // Static / embedded assets — must be first so they take precedence over
  // the SPA catch-all
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

  "/*": index,

  ...configRoutes(),
  ...providerRoutes(),
  ...imageRoutes(),
  ...mediaManagementRoutes(),
  ...backupRoutes(),
  ...debugRoutes(),
  ...integrationRoutes(),
  ...analyticsRoutes(),
  ...pipelineRoutes(),
  ...backgroundJobRoutes(),
  ...notificationRoutes(),
};

// ---- Lazy route definitions (depend on scheduler / systemManager) ----------

function lazyRoutes() {
  return {
    ...showRoutes(scheduler, systemManager),
    ...searchRoutes(systemManager),
    ...systemRoutes(scheduler, systemManager, isShuttingDown),
    ...miscRoutes(systemManager),
    ...updateRoutes(ADMIN_TOKEN),
  };
}

// ---- Debug logging wrapper ------------------------------------------------

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

// ---- Server bootstrap -----------------------------------------------------

const config = loadConfig();
const scheduler = new Scheduler(config);
const systemManager = new SystemManager(() => loadConfig());

// Merge lazy routes (which need scheduler/systemManager) into routeDefinitions
Object.assign(routeDefinitions, lazyRoutes());

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

scheduler.start();

console.log(`🚀 Server running at ${server.url} (release ${BUILD_COMMIT}, version ${BUILD_VERSION})`);

// ---- Graceful shutdown ----------------------------------------------------

let sigtermReceived = false;
process.on("SIGTERM", async () => {
  if (sigtermReceived) return;
  sigtermReceived = true;

  shuttingDown = true;

  for (const ws of debugWsClients) {
    try { (ws as any).close(1012, "server restarting"); } catch { }
  }

  await scheduler.stop?.();

  db.close?.();

  process.exit(0);
});
