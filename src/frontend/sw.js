// ShowFlow service worker
//
// Scope: navigation requests only. This SW never caches or serves API
// responses, JS/CSS, or other subresources — each release ships its own
// build artifacts, and caching them here risks serving assets from release
// N against a backend that's already running release N+1. It exists purely
// to keep the tab "alive" across the supervisor's stop/start handoff
// window (sub-second to low-seconds 503s) instead of showing the browser's
// default offline/error page.
//
// Cache-bust this by changing CACHE_VERSION if offline.html's markup changes.
const CACHE_VERSION = 'showflow-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
  );
  // Take over immediately — there's no meaningful "old version" of this SW
  // to keep serving; the offline page it fronts is static and versionless
  // from the app's perspective.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Passthrough for everything except top-level navigations. Let the
  // browser handle API calls, assets, WS upgrade attempts, etc. natively —
  // no respondWith() means this listener has no effect on the request.
  if (request.mode !== 'navigate') {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);

        // The supervisor's proxy returns 503 + Retry-After while it has
        // SIGTERM'd the old process and hasn't finished starting/verifying
        // the new one yet. Treat that identically to a network failure.
        if (response.status === 503) {
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
        }

        return response;
      } catch (err) {
        // Connection refused/reset — process is mid-restart or the pod
        // itself is momentarily unreachable.
        const offline = await caches.match(OFFLINE_URL);
        return offline || Response.error();
      }
    })()
  );
});
