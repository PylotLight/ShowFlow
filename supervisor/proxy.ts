// Explicit request construction rather than a bare passthrough, so headers
// that would otherwise leak supervisor-internal routing details (or let a
// client spoof x-forwarded-for) are controlled deliberately.
//
// WebSocket traffic used to be a known gap here: this is a plain fetch()
// proxy, and fetch() cannot forward an `Upgrade` handshake, so /api/debug/ws
// always showed DISCONNECTED in the pod. It now has a real bridge — see
// isWebSocketUpgrade / attemptWebSocketUpgrade / debugSocket handlers below —
// which upgrades the client here in the supervisor and pipes messages
// bidirectionally to a fresh `ws://127.0.0.1:<activePort>` connection.
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

// ---- WebSocket bridge -------------------------------------------------------

const _OPEN = 1; // WebSocket.OPEN — avoid depending on the ambient constant

/** True when the incoming request is a WebSocket `Upgrade` handshake. */
export function isWebSocketUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade")?.toLowerCase() ?? "";
  return upgrade === "websocket" || upgrade.includes("websocket");
}

/**
 * Per-socket state attached to a bridged client connection. `data` is seeded
 * by attemptWebSocketUpgrade() with what we need to dial the active app, then
 * the open/message/close handlers fill in the live upstream + read buffer.
 */
export interface DebugSocketData {
  /** The active app's internal listen port (manager.activePort). */
  port: number;
  /** Request path, e.g. "/api/debug/ws". */
  path: string;
  /** Raw query string (with leading "?") or "". */
  search: string;
  /** Live `ws://127.0.0.1:<port>` connection to the app, once opened. */
  upstream?: WebSocket;
  /** Client messages that arrived before the upstream finished opening. */
  pending: Array<string | Uint8Array>;
  /** Set once either side has shut the bridge down, so late events are ignored. */
  closed?: boolean;
}

/**
 * Upgrades the client's connection here in the supervisor (the only place a
 * real Upgrade handshake can be served) and records where this socket should
 * be bridged to. Returns true on success; the caller must not return a
 * Response after a successful upgrade.
 */
export function attemptWebSocketUpgrade(
  req: Request,
  server: { upgrade(req: Request, opts?: { data?: DebugSocketData }): boolean },
  port: number,
): boolean {
  const url = new URL(req.url);
  return server.upgrade(req, {
    data: { port, path: url.pathname, search: url.search, pending: [] },
  });
}

/** Client socket opened — dial the active app and start piping. */
export function openDebugBridge(ws: any): void {
  const data = (ws.data ?? {}) as DebugSocketData;
  ws.data = data;
  data.closed = false;

  if (!data.port || !data.path) {
    try { ws.close(1011, "missing bridge target"); } catch {}
    return;
  }

  const upstream = new WebSocket(`ws://127.0.0.1:${data.port}${data.path}${data.search}`);
  data.upstream = upstream;

  upstream.addEventListener("open", () => {
    if (data.closed) {
      try { upstream.close(); } catch {}
      return;
    }
    for (const msg of data.pending) upstream.send(msg as string);
    data.pending = [];
  });

  upstream.addEventListener("message", (event) => {
    if (ws.readyState !== _OPEN) return;
    try { ws.send(event.data); } catch {}
  });

  upstream.addEventListener("close", () => {
    if (ws.readyState === _OPEN) { try { ws.close(1011, "upstream closed"); } catch {} }
  });

  upstream.addEventListener("error", () => {
    try { upstream.close(); } catch {}
  });
}

/** Client message: forward to the app, buffering until its socket is open. */
export function forwardDebugMessage(ws: any, message: string | Buffer): void {
  const data = (ws.data ?? {}) as DebugSocketData;
  const upstream = data.upstream;
  if (upstream?.readyState === _OPEN) {
    try { upstream.send(message.toString()); } catch {}
  } else if (!data.closed) {
    data.pending.push(message);
  }
}

/** Client socket closed: tear down the upstream connection, if any. */
export function closeDebugBridge(ws: any, code: number, reason: string): void {
  const data = (ws.data ?? {}) as DebugSocketData;
  data.closed = true;
  const upstream = data.upstream;
  if (upstream && upstream.readyState === _OPEN) {
    try { upstream.close(code, reason); } catch {}
  }
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
