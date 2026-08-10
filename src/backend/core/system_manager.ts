import { LibraryScanner } from '../core/library_scanner';
import { DownloadManager } from '../core/download_manager';
import { BlackholeClient } from './download_clients/blackhole';
import { db, type Config } from '../db';

export class SystemManager {
  private config: Config;
  private getConfig: () => Config;
  private watcher: DownloadManager | null = null;
  private manualClient: BlackholeClient | null = null;

  /**
   * Short-lived cache for the manual-import file listing. Resolving every
   * watch-folder file on every page load is expensive (the previous
   * implementation pulled multi-GB episode payloads per file from providers,
   * OOMing the pod); listing the UI is much cheaper when a refresh within a
   * few seconds returns the cached result.
   */
  private manualImportCache: {
    expires: number;
    data: any[];
  } | null = null;

  private static readonly MANUAL_IMPORT_CACHE_TTL_MS = 30 * 1000;

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig;
    this.config = getConfig();
  }

  private refreshConfig() {
    this.config = this.getConfig();
  }

  /**
   * Resolve the blackhole client for Manual Import operations WITHOUT
   * depending on the watcher process. Manual Import must stay usable even
   * when the download watcher has crashed/stopped — the ops only read the
   * configured watch folder, they don't need the OS file watcher attached.
   * Prefers the live watcher's client when it exists so state (in-flight
   * queue etc.) stays consistent; otherwise spins up a folder-only client
   * whose folder comes from the live config.
   */
  private getManualImportClient(): BlackholeClient | null {
    this.refreshConfig();
    const folder = this.config.downloadClient?.blackhole?.watchFolder;
    if (!folder?.trim()) return null;

    const liveClient = (this.watcher as any)?.clients?.get('blackhole') as BlackholeClient | undefined;
    if (liveClient?.getWatchFolder()) return liveClient;

    if (!this.manualClient?.getWatchFolder()) {
      this.manualClient = new BlackholeClient(this.config);
      this.manualClient.attachFolderForManualOps();
    }
    return this.manualClient;
  }

  async scan() {
    this.refreshConfig();
    const scanner = new LibraryScanner(this.config);
    return await scanner.scan();
  }

  async scanShow(showId: string) {
    this.refreshConfig();
    const scanner = new LibraryScanner(this.config);
    await scanner.scanShow(showId);
  }

  async startWatcher() {
    this.refreshConfig();
    if (this.watcher) {
      throw new Error('Watcher is already running.');
    }
    this.watcher = new DownloadManager(this.config);
    await this.watcher.start();
    return { status: 'started' };
  }

  async stopWatcher() {
    if (!this.watcher) {
      throw new Error('Watcher is not running.');
    }
    await this.watcher.stop();
    this.watcher = null;
    return { status: 'stopped' };
  }

  isWatching() {
    return this.watcher !== null;
  }

  getProcessingFiles(): string[] {
    return this.watcher ? this.watcher.getProcessingFiles() : [];
  }

  getWatcher(): DownloadManager | null {
    return this.watcher;
  }

  async rescanWatcher() {
    this.refreshConfig();
    if (!this.watcher) {
      throw new Error('Watcher is not running.');
    }
    const folder = this.config.downloadClient?.blackhole?.watchFolder;
    if (!folder) {
      throw new Error('No watch folder configured.');
    }
    // Access the BlackholeClient's scan method
    const client = (this.watcher as any).clients?.get('blackhole');
    if (client && typeof client.scanExistingFiles === 'function') {
      await client.scanExistingFiles(folder);
      return { status: 'rescanned' };
    }
    throw new Error('Blackhole client not available or does not support scanning.');
  }

  async listManualImportFiles(): Promise<any[]> {
    const now = Date.now();
    if (this.manualImportCache && this.manualImportCache.expires > now) {
      return this.manualImportCache.data;
    }
    const client = this.getManualImportClient();
    if (!client) return [];
    const data = await client.listWatchFolderFiles();
    this.manualImportCache = {
      expires: now + SystemManager.MANUAL_IMPORT_CACHE_TTL_MS,
      data,
    };
    return data;
  }

  invalidateManualImportCache(): void {
    this.manualImportCache = null;
  }

  async forceImportFile(
    filename: string,
    showId?: string,
    overrides?: { season?: number; episodes?: number[] },
  ): Promise<{ ok: boolean; message: string }> {
    const client = this.getManualImportClient();
    if (!client) return { ok: false, message: 'No watch folder configured.' };
    const res = await client.forceImport(filename, showId, overrides);
    if (res.ok) this.invalidateManualImportCache();
    return res;
  }

  async deleteWatchFile(filename: string): Promise<{ ok: boolean; message: string }> {
    const client = this.getManualImportClient();
    if (!client) return { ok: false, message: 'No watch folder configured.' };
    const res = await client.deleteFile(filename);
    if (res.ok) this.invalidateManualImportCache();
    return res;
  }

  async countWatchFiles(): Promise<number> {
    const client = this.getManualImportClient();
    if (!client) return 0;
    return client.countWatchFolderFiles();
  }

  getMemoryStats(): Record<string, unknown> {
    const u = process.memoryUsage();
    let cgroup: Record<string, number> | null = null;
    try {
      const cur = Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      const max = Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
      cgroup = { currentBytes: cur, maxBytes: max, currentMB: +(cur / 1048576).toFixed(0), maxMB: +(max / 1048576).toFixed(0) };
    } catch {
      try {
        const cur = Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'));
        const max = Number(require('node:fs').readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'));
        cgroup = { currentBytes: cur, maxBytes: max, currentMB: +(cur / 1048576).toFixed(0), maxMB: +(max / 1048576).toFixed(0) };
      } catch {}
    }
    let vmrss: string | null = null;
    try {
      vmrss = require('node:fs').readFileSync('/proc/self/status', 'utf8').match(/VmRSS:\s+(\d+\s+\w+)/)?.[1] ?? null;
    } catch {}
    return {
      rssMB: +(u.rss / 1048576).toFixed(0),
      heapUsedMB: +(u.heapUsed / 1048576).toFixed(0),
      externalMB: +(u.external / 1048576).toFixed(0),
      arrayBuffersMB: +((u.arrayBuffers || 0) / 1048576).toFixed(0),
      cgroup,
      vmrss,
      pid: process.pid,
      ts: new Date().toISOString(),
    };
  }
}
