// Explicit request construction rather than a bare passthrough, so headers
// that would otherwise leak supervisor-internal routing details (or let a
// client spoof x-forwarded-for) are controlled deliberately.
//
// NOTE (Phase 1 known gap, tracked for Phase 2): this is a plain fetch()
// proxy. It does not — and cannot — forward a WebSocket `Upgrade` handshake.
// /api/debug/ws will not work through the supervisor until Phase 2 adds
// either a supervisor-side WS bridge or a proven HTTP-upgrade-aware proxy
// in front of this. Don't let that surface as a surprise during an
// incident — it's a known, deliberately-deferred gap, not an oversight.
export async function proxy(req: Request, upstreamPort: number): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(req.url);
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = String(upstreamPort);

  const headers = new Headers(req.headers);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  headers.delete("forwarded");
  headers.delete("x-forwarded-for");

  const init: RequestInit = { method: req.method, headers, redirect: "manual", signal: req.signal };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return fetch(target, init);
}

export function unavailableResponse(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: {
      "Retry-After": "2",
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
