import { CONNECT_EVENT_LABELS, type ConnectMessage, type NotificationTarget } from './types';

/** Pure: target + message -> the exact HTTP request to send. Unit-tested. */
export interface OutboundRequest {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
}

const NTFY_TAGS: Record<ConnectMessage['event'], string> = {
  grabbed: 'arrow_down',
  imported: 'tv',
  failed: 'warning',
  health: 'rotating_light',
  update: 'package',
};

const DISCORD_COLORS: Record<ConnectMessage['severity'], number> = {
  info: 0x3b82f6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  error: 0xef4444,
};

const APPRISE_TYPES: Record<ConnectMessage['severity'], string> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'failure',
};

const trimSlash = (s: string) => s.replace(/\/+$/, '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function ntfyAuth(token: string): string | null {
  if (!token) return null;
  // "user:pass" -> basic auth; anything else is an access token (tk_...).
  if (token.includes(':')) return `Basic ${Buffer.from(token).toString('base64')}`;
  return `Bearer ${token}`;
}

export function formatRequest(target: NotificationTarget, msg: ConnectMessage): OutboundRequest {
  const json = { 'Content-Type': 'application/json' };
  switch (target.type) {
    case 'ntfy': {
      const headers: Record<string, string> = { ...json };
      const auth = ntfyAuth(target.token);
      if (auth) headers.Authorization = auth;
      // JSON publishing goes to the server root with the topic in the body,
      // which keeps unicode titles intact (header-based titles can't).
      return {
        url: trimSlash(target.url),
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            topic: target.topic,
            title: clip(msg.title, 250),
            message: clip(msg.body || msg.title, 4000),
            tags: [NTFY_TAGS[msg.event]],
            priority: msg.severity === 'error' || msg.severity === 'warning' ? 4 : 3,
          }),
        },
      };
    }
    case 'discord':
      return {
        url: target.webhookUrl,
        init: {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            username: 'ShowFlow',
            embeds: [{
              title: clip(msg.title, 256),
              description: clip(msg.body, 4096) || undefined,
              color: DISCORD_COLORS[msg.severity],
              timestamp: msg.timestamp,
              footer: { text: CONNECT_EVENT_LABELS[msg.event] },
            }],
          }),
        },
      };
    case 'apprise': {
      const body: Record<string, unknown> = {
        title: msg.title,
        body: msg.body || msg.title,
        type: APPRISE_TYPES[msg.severity],
        format: 'text',
      };
      if (target.tags.trim()) body.tag = target.tags.trim();
      return { url: target.url, init: { method: 'POST', headers: json, body: JSON.stringify(body) } };
    }
    case 'webhook': {
      const headers: Record<string, string> = { ...json };
      if (target.authHeader) headers.Authorization = target.authHeader;
      return {
        url: target.url,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            app: 'showflow',
            event: msg.event,
            title: msg.title,
            message: msg.body,
            severity: msg.severity,
            timestamp: msg.timestamp,
            ...(msg.data ? { data: msg.data } : {}),
          }),
        },
      };
    }
  }
}

export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function sendToTarget(
  target: NotificationTarget,
  msg: ConnectMessage,
  fetchImpl: FetchLike = fetch as any,
  timeoutMs = 10_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const req = formatRequest(target, msg);
  try {
    const res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${clip(text, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
