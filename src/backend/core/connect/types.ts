import { z } from 'zod';

/** Events a notification target can subscribe to. */
export const CONNECT_EVENTS = ['grabbed', 'imported', 'failed', 'health', 'update'] as const;
export type ConnectEventKind = (typeof CONNECT_EVENTS)[number];

export const CONNECT_EVENT_LABELS: Record<ConnectEventKind, string> = {
  grabbed: 'Grabbed',
  imported: 'Imported / upgraded',
  failed: 'Download failed',
  health: 'Health issue',
  update: 'Update available',
};

const url = (what: string) =>
  z.string().trim().refine(v => /^https?:\/\/.+/i.test(v), { message: `${what} must be an http(s) URL` });

const EventToggles = z.object({
  grabbed: z.boolean().default(true),
  imported: z.boolean().default(true),
  failed: z.boolean().default(true),
  health: z.boolean().default(true),
  update: z.boolean().default(true),
});

const base = {
  id: z.string().min(1),
  name: z.string().trim().min(1, 'Name is required').max(80),
  enabled: z.boolean().default(true),
  events: EventToggles.default({ grabbed: true, imported: true, failed: true, health: true, update: true }),
};

export const NtfyTargetSchema = z.object({
  ...base,
  type: z.literal('ntfy'),
  url: url('ntfy server URL'),
  topic: z.string().trim().regex(/^[-_A-Za-z0-9]{1,64}$/, 'ntfy topic may only use letters, numbers, - and _'),
  token: z.string().default(''),
});

export const DiscordTargetSchema = z.object({
  ...base,
  type: z.literal('discord'),
  webhookUrl: url('Discord webhook URL'),
});

export const AppriseTargetSchema = z.object({
  ...base,
  type: z.literal('apprise'),
  /** Full notify endpoint, e.g. http://apprise:8000/notify/showflow */
  url: url('Apprise API URL'),
  tags: z.string().default(''),
});

export const WebhookTargetSchema = z.object({
  ...base,
  type: z.literal('webhook'),
  url: url('Webhook URL'),
  /** Optional Authorization header value, e.g. "Bearer abc". */
  authHeader: z.string().default(''),
});

export const NotificationTargetSchema = z.discriminatedUnion('type', [
  NtfyTargetSchema, DiscordTargetSchema, AppriseTargetSchema, WebhookTargetSchema,
]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;
export type NotificationTargetType = NotificationTarget['type'];

/** ShowFlow-path -> media-server-path prefix rewrite (container mounts differ). */
const PathMap = z.object({ from: z.string().default(''), to: z.string().default('') });

export const MediaRefreshSchema = z.object({
  /** Uses the existing Jellyfin integration's URL + API key. */
  jellyfin: z.object({
    enabled: z.boolean().default(false),
    pathMap: PathMap.default({ from: '', to: '' }),
  }).default({ enabled: false, pathMap: { from: '', to: '' } }),
  plex: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().trim().default('').refine(v => v === '' || /^https?:\/\/.+/i.test(v), { message: 'Plex URL must be an http(s) URL' }),
    token: z.string().default(''),
    pathMap: PathMap.default({ from: '', to: '' }),
  }).default({ enabled: false, baseUrl: '', token: '', pathMap: { from: '', to: '' } }),
  /** Coalesce window: imports landing within this many seconds share one refresh. */
  debounceSeconds: z.number().int().min(1).max(600).default(30),
});
export type MediaRefreshConfig = z.infer<typeof MediaRefreshSchema>;

export const ConnectSettingsSchema = z.object({
  targets: z.array(NotificationTargetSchema).default([]),
  mediaRefresh: MediaRefreshSchema.default(MediaRefreshSchema.parse({})),
});
export type ConnectSettings = z.infer<typeof ConnectSettingsSchema>;

/** A notification ready to format for any target. */
export interface ConnectMessage {
  event: ConnectEventKind;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
  /** Extra structured detail for the generic webhook. */
  data?: Record<string, unknown>;
}

export const SECRET_MASK = '********';
