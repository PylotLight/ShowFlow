import {
  ConnectSettingsSchema, MediaRefreshSchema, NotificationTargetSchema, SECRET_MASK,
  type ConnectSettings, type MediaRefreshConfig, type NotificationTarget,
} from './types';

/**
 * Connect config lives in the settings KV under one key, same as the other
 * integrations (jellyfin/sonarr/prowlarr). Secrets go out masked ("********")
 * and a masked value coming back in means "keep what's stored".
 */
export const CONNECT_SETTING_KEY = 'connect';

/** Per target type: which fields are secrets. */
const SECRET_FIELDS: Record<NotificationTarget['type'], string[]> = {
  ntfy: ['token'],
  discord: ['webhookUrl'],
  apprise: [],
  webhook: ['authHeader'],
};

export interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: any): void;
}

export function parseConnectSettings(raw: unknown): ConnectSettings {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = {}; }
  }
  const res = ConnectSettingsSchema.safeParse(obj ?? {});
  if (res.success) return res.data;
  // Drop individually-broken targets rather than losing the whole config.
  const o = (obj && typeof obj === 'object' ? obj : {}) as any;
  const targets = Array.isArray(o.targets)
    ? o.targets.map((t: unknown) => NotificationTargetSchema.safeParse(t)).filter((r: any) => r.success).map((r: any) => r.data)
    : [];
  const media = MediaRefreshSchema.safeParse(o.mediaRefresh ?? {});
  return { targets, mediaRefresh: media.success ? media.data : MediaRefreshSchema.parse({}) };
}

export function loadConnectSettings(store: SettingsStore): ConnectSettings {
  return parseConnectSettings(store.getSetting(CONNECT_SETTING_KEY));
}

export function saveConnectSettings(store: SettingsStore, settings: ConnectSettings): void {
  store.setSetting(CONNECT_SETTING_KEY, ConnectSettingsSchema.parse(settings));
}

const mask = (v: string) => (v ? SECRET_MASK : '');

export function maskTarget(t: NotificationTarget): NotificationTarget {
  const out: any = { ...t };
  for (const f of SECRET_FIELDS[t.type]) out[f] = mask(out[f] ?? '');
  return out;
}

export function maskSettings(s: ConnectSettings): ConnectSettings {
  return {
    targets: s.targets.map(maskTarget),
    mediaRefresh: {
      ...s.mediaRefresh,
      plex: { ...s.mediaRefresh.plex, token: mask(s.mediaRefresh.plex.token) },
    },
  };
}

/**
 * Validate an incoming target, restoring masked secrets from the stored copy
 * with the same id (and same type — switching type drops old secrets).
 */
export function mergeIncomingTarget(
  incoming: Record<string, any>,
  existing: NotificationTarget | undefined,
): { ok: true; target: NotificationTarget } | { ok: false; error: string } {
  const merged: Record<string, any> = { ...incoming };
  const type = merged.type as NotificationTarget['type'];
  for (const f of SECRET_FIELDS[type] ?? []) {
    if (merged[f] === SECRET_MASK) {
      merged[f] = existing && existing.type === type ? (existing as any)[f] ?? '' : '';
    }
  }
  const res = NotificationTargetSchema.safeParse(merged);
  if (!res.success) return { ok: false, error: res.error.issues.map(i => i.message).join('; ') };
  return { ok: true, target: res.data };
}

export function mergeIncomingMediaRefresh(
  incoming: Record<string, any>,
  existing: MediaRefreshConfig,
): { ok: true; value: MediaRefreshConfig } | { ok: false; error: string } {
  const merged: any = {
    ...existing,
    ...incoming,
    jellyfin: { ...existing.jellyfin, ...(incoming.jellyfin ?? {}) },
    plex: { ...existing.plex, ...(incoming.plex ?? {}) },
  };
  if (merged.plex.token === SECRET_MASK) merged.plex.token = existing.plex.token;
  const res = MediaRefreshSchema.safeParse(merged);
  if (!res.success) return { ok: false, error: res.error.issues.map(i => i.message).join('; ') };
  return { ok: true, value: res.data };
}
