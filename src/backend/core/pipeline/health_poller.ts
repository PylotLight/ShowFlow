import { access, constants } from 'node:fs/promises';
import { db, ProwlarrConfigSchema, type Config } from '../../db';
import { IndexerFactory } from '../../providers/indexers/factory';
import type { NativeIndexerConfig } from '../../providers/indexers/native/types';
import { NATIVE_INDEXER_META } from '../../providers/indexers/native/types';
import { TorboxClient } from '../../providers/torbox/client';
import { debugLog } from '../debug';

/**
 * Polls every configured indexer, download client, and import path and
 * writes the result into the system_health snapshot (db/health.ts). This is
 * the write side of the design brief's §5 "System Health Snapshot"
 * primitive - nothing called it before this, the table just existed.
 *
 * Each of the three sections below is independent and swallows its own
 * errors into a 'down' health row rather than throwing, so one bad
 * indexer/client/path can't stop the others from being checked - the whole
 * point of this poller is to surface exactly that kind of isolated failure.
 */
export async function pollSystemHealth(config: Config): Promise<void> {
  await Promise.all([
    pollIndexers(),
    pollDownloadClients(config),
    pollImportPaths(),
  ]);
}

async function pollIndexers() {
  // Prowlarr
  const prowlarrRaw = db.getSetting('prowlarr');
  if (prowlarrRaw) {
    try {
      const parsed = ProwlarrConfigSchema.parse(typeof prowlarrRaw === 'string' ? JSON.parse(prowlarrRaw) : prowlarrRaw);
      if (parsed.enabled) {
        try {
          const instance = IndexerFactory.create('prowlarr', parsed);
          const result = await instance.validate();
          db.upsertHealthStatus({
            componentType: 'indexer',
            componentId: 'prowlarr',
            componentName: 'Prowlarr',
            status: result.ok ? 'healthy' : 'down',
            reasonCode: result.ok ? undefined : 'INDEXER_UNREACHABLE',
            message: result.ok ? (result.version ? `Connected (v${result.version})` : 'Connected') : (result.message || 'Validation failed'),
          });
        } catch (e) {
          db.upsertHealthStatus({
            componentType: 'indexer', componentId: 'prowlarr', componentName: 'Prowlarr',
            status: 'down', reasonCode: 'INDEXER_UNREACHABLE',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        db.removeHealthComponent('indexer', 'prowlarr');
      }
    } catch (e) {
      debugLog(`[HealthPoller] Prowlarr config invalid, skipping: ${e}`);
    }
  } else {
    db.removeHealthComponent('indexer', 'prowlarr');
  }

  // Native indexers
  const nativeRaw = db.getSetting('nativeIndexers');
  if (!nativeRaw) return;

  let configs: NativeIndexerConfig[] = [];
  try {
    configs = JSON.parse(typeof nativeRaw === 'string' ? nativeRaw : nativeRaw);
  } catch (e) {
    debugLog(`[HealthPoller] Native indexer config invalid, skipping: ${e}`);
    return;
  }

  for (const cfg of configs) {
    if (!cfg.enabled) {
      db.removeHealthComponent('indexer', cfg.id);
      continue;
    }
    const displayName = NATIVE_INDEXER_META[cfg.id]?.name ?? cfg.id;
    try {
      const instance = IndexerFactory.createNative(cfg);
      const result = await instance.validate();
      db.upsertHealthStatus({
        componentType: 'indexer',
        componentId: cfg.id,
        componentName: displayName,
        status: result.ok ? 'healthy' : 'down',
        reasonCode: result.ok ? undefined : 'INDEXER_UNREACHABLE',
        message: result.ok ? 'Connected' : (result.message || 'Validation failed'),
      });
    } catch (e) {
      db.upsertHealthStatus({
        componentType: 'indexer', componentId: cfg.id, componentName: displayName,
        status: 'down', reasonCode: 'INDEXER_UNREACHABLE',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function pollDownloadClients(config: Config) {
  // Blackhole - "healthy" here just means the watch folder exists and is
  // writable, there's no remote service to ping.
  const blackholeFolder = config.downloadClient?.blackhole?.watchFolder;
  if (blackholeFolder) {
    try {
      await access(blackholeFolder, constants.W_OK);
      db.upsertHealthStatus({
        componentType: 'download_client', componentId: 'blackhole', componentName: 'Blackhole',
        status: 'healthy', message: `Watch folder writable: ${blackholeFolder}`,
      });
    } catch (e) {
      db.upsertHealthStatus({
        componentType: 'download_client', componentId: 'blackhole', componentName: 'Blackhole',
        status: 'down', reasonCode: 'WATCH_FOLDER_UNAVAILABLE',
        message: `Watch folder "${blackholeFolder}" is missing or not writable: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } else {
    db.removeHealthComponent('download_client', 'blackhole');
  }

  // TorBox - a real credential check against the account endpoint, not just "is a key present".
  const torboxCfg = config.downloadClient?.torbox;
  if (torboxCfg?.apiKey) {
    try {
      const client = new TorboxClient({ apiKey: torboxCfg.apiKey, baseUrl: torboxCfg.baseUrl || 'https://api.torbox.app' });
      await client.getUserInfo();
      db.upsertHealthStatus({
        componentType: 'download_client', componentId: 'torbox', componentName: 'TorBox',
        status: 'healthy', message: 'Connected',
      });
    } catch (e) {
      db.upsertHealthStatus({
        componentType: 'download_client', componentId: 'torbox', componentName: 'TorBox',
        status: 'down', reasonCode: 'DOWNLOAD_CLIENT_UNREACHABLE',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    db.removeHealthComponent('download_client', 'torbox');
  }
}

async function pollImportPaths() {
  const profiles = db.listShowProfiles();
  const seen = new Set<string>();

  for (const profile of profiles) {
    seen.add(profile.id);
    try {
      await access(profile.root_folder_path, constants.W_OK);
      db.upsertHealthStatus({
        componentType: 'import_path', componentId: profile.id, componentName: profile.name,
        status: 'healthy', message: `Writable: ${profile.root_folder_path}`,
      });
    } catch (e) {
      db.upsertHealthStatus({
        componentType: 'import_path', componentId: profile.id, componentName: profile.name,
        status: 'down', reasonCode: 'IMPORT_PATH_UNAVAILABLE',
        message: `"${profile.root_folder_path}" is missing or not writable: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // A profile that was deleted shouldn't leave a stale health row behind.
  const existing = db.getHealthSnapshot().byType.import_path;
  for (const row of existing) {
    if (!seen.has(row.component_id)) {
      db.removeHealthComponent('import_path', row.component_id);
    }
  }
}
