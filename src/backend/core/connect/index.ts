import { db, JellyfinConfigSchema } from '../../db';
import * as schema from '../../db/schema';
import { JellyfinClient } from '../../providers/jellyfin/client';
import { PlexClient } from '../../providers/plex/client';
import { onConnectSignal } from './bus';
import { MediaRefreshQueue, type MediaTargets, type RefreshRun } from './media_refresh';
import { Notifier, testMessage } from './notifier';
import { sendToTarget } from './notify_format';
import { loadConnectSettings } from './settings';
import type { ConnectSettings, NotificationTarget } from './types';

/**
 * Wires the connect bus to the notifier + media refresh queue. Started once
 * from server.ts; settings are cached and re-read after every save.
 */
let cached: ConnectSettings | null = null;
const settings = (): ConnectSettings => (cached ??= loadConnectSettings(db));
export function invalidateConnectSettings() { cached = null; }

let lastRefresh: RefreshRun | null = null;
export const getLastMediaRefresh = () => lastRefresh;

function jellyfinClient(): JellyfinClient | null {
  const raw = db.getSetting('jellyfin');
  if (!raw) return null;
  try {
    const cfg = JellyfinConfigSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!cfg.baseUrl || !cfg.apiKey) return null;
    return new JellyfinClient(cfg.baseUrl, cfg.apiKey);
  } catch {
    return null;
  }
}

export function plexClientFrom(cfg: ConnectSettings['mediaRefresh']['plex']): PlexClient | null {
  return cfg.baseUrl && cfg.token ? new PlexClient(cfg.baseUrl, cfg.token) : null;
}

export function mediaTargets(s: ConnectSettings = settings()): MediaTargets {
  const mr = s.mediaRefresh;
  const jf = mr.jellyfin.enabled ? jellyfinClient() : null;
  const px = mr.plex.enabled ? plexClientFrom(mr.plex) : null;
  return {
    jellyfin: jf ? { client: jf, pathMap: mr.jellyfin.pathMap } : null,
    plex: px ? { client: px, pathMap: mr.plex.pathMap } : null,
  };
}

const notifier = new Notifier({
  getTargets: () => settings().targets,
  showTitle: (id) => (db.getShow(id) as any)?.title ?? null,
  log: (m) => console.warn(m),
});

const refreshQueue = new MediaRefreshQueue({
  getTargets: () => mediaTargets(),
  windowMs: () => settings().mediaRefresh.debounceSeconds * 1000,
  onRun: (run) => {
    lastRefresh = run;
    const bits = [
      run.jellyfin && `jellyfin ${run.jellyfin.mode} ${run.jellyfin.ok ? 'ok' : `failed: ${run.jellyfin.error}`}`,
      run.plex && `plex ${run.plex.ok ? `ok (${run.plex.refreshed.length} folder${run.plex.refreshed.length === 1 ? '' : 's'})` : `failed: ${run.plex.error}`}`,
    ].filter(Boolean);
    console.log(`[connect] media refresh for ${run.dirs.length} folder(s): ${bits.join('; ')}`);
  },
});

let started = false;
export function startConnect(): void {
  if (started) return;
  started = true;
  try {
    const rows = db.drizz.select().from(schema.systemHealth).all();
    notifier.seedHealth(rows.map(r => ({ componentType: r.component_type, componentId: r.component_id, status: r.status })));
  } catch { /* fresh db */ }

  onConnectSignal((signal) => {
    notifier.handle(signal);
    if (signal.source === 'pipeline' && signal.eventType === 'import_completed') {
      const filePath = signal.metadata?.filePath;
      if (typeof filePath === 'string' && filePath) refreshQueue.add(filePath);
    }
  });
}

export async function stopConnect(): Promise<void> {
  await Promise.allSettled([notifier.flushAll(), refreshQueue.flush()]);
}

export function testTarget(target: NotificationTarget) {
  return sendToTarget(target, testMessage());
}
