/**
 * Local view (read-only) mode — SHOWFLOW_LOCAL_VIEW=1.
 *
 * Used by the Showfish desktop app (desktop/) to browse a restored backup on
 * a laptop. Nothing may download, grab, import, scan, back up, self-update or
 * talk to the NAS's indexers / download clients. The normal server never sets
 * the flag, so every guard here is a no-op for it.
 *
 * Boot side: server.ts skips the scheduler, Connect, the download watcher,
 * the release watcher and the artwork migration, and binds to 127.0.0.1
 * only (Scheduler.start and SystemManager.startWatcher refuse too, as a
 * backstop).
 *
 * Request side: every mutating /api route answers 403, plus the GET routes
 * that reach out to indexers / download clients / Sonarr / Jellyfin / the
 * update feed. Plain reads (shows, episodes, calendar, history, images…) pass.
 * Artwork that isn't on disk still re-warms from the metadata providers.
 */

export const LOCAL_VIEW_ENV = 'SHOWFLOW_LOCAL_VIEW';

export function isLocalView(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[LOCAL_VIEW_ENV];
  return v === '1' || v === 'true';
}

/** Non-GET routes that only compute a preview or touch local UI state. */
const MUTATING_ALLOW = new Set<string>([
  '/api/naming/preview',
  '/api/quality/test',
  '/api/notifications/dismiss',
  '/api/notifications/restore',
]);

/** Route patterns (any method) that touch indexers, download clients, the
 *  watcher, external integrations, backup files or the update feed. */
const OUTBOUND_DENY: RegExp[] = [
  /^\/api\/search(\/|$)/,
  /^\/api\/indexers\//,
  /\/search$/, // per-show / season / episode / movie indexer searches
  /\/grab$/,
  /^\/api\/sonarr\//,
  /^\/api\/jellyfin\//,
  /^\/api\/connect\/.*(test|refresh)$/,
  /^\/api\/manual-import\//,
  /^\/api\/system\/(watch|scan|processing\/cancel|db-cleanup)/,
  /^\/api\/admin\/updates\/(available|check|install|update-now|activate)$/,
  /^\/api\/backups\//,
  /^\/api\/feedback$/,
];

/** Metadata-provider lookups are fine (they're how artwork re-warms). */
const OUTBOUND_ALLOW: RegExp[] = [
  /^\/api\/providers\/:source\/search$/,
];

/**
 * Should this route be refused in local view? `path` is the route pattern
 * as registered with Bun.serve (e.g. "/api/shows/:id/sync").
 */
export function localViewBlocks(method: string, path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  if (path === '/api/debug/ws' || path === '/api/debug/logs') return false;
  if (OUTBOUND_ALLOW.some((re) => re.test(path))) return false;
  if (OUTBOUND_DENY.some((re) => re.test(path))) return true;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  return !MUTATING_ALLOW.has(path);
}

function blocked(): Response {
  return new Response(
    JSON.stringify({ error: 'Local view: ShowFlow is running read-only, this action is disabled.' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Swap the handlers of every blocked route for a 403. Mutates `defs`. */
export function applyLocalViewGuard<T extends Record<string, any>>(defs: T): T {
  for (const [path, handlers] of Object.entries(defs)) {
    if (typeof handlers !== 'object' || handlers === null || handlers instanceof Response) continue;
    if (!path.startsWith('/api/')) continue;
    for (const [method, handler] of Object.entries(handlers)) {
      if (typeof handler === 'function' && localViewBlocks(method, path)) {
        (handlers as Record<string, unknown>)[method] = blocked;
      }
    }
  }
  return defs;
}
