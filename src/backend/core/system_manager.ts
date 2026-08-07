import { LibraryScanner } from '../core/library_scanner';
import { DownloadManager } from '../core/download_manager';
import { db, type Config } from '../db';

export class SystemManager {
  private config: Config;
  private getConfig: () => Config;
  private watcher: DownloadManager | null = null;

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig;
    this.config = getConfig();
  }

  private refreshConfig() {
    this.config = this.getConfig();
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
    if (!this.watcher) {
      throw new Error('Watcher is not running.');
    }
    const client = (this.watcher as any).clients?.get('blackhole');
    if (client && typeof client.listWatchFolderFiles === 'function') {
      return client.listWatchFolderFiles();
    }
    throw new Error('Blackhole client not available.');
  }

  async forceImportFile(filename: string): Promise<{ ok: boolean; message: string }> {
    if (!this.watcher) {
      return { ok: false, message: 'Watcher is not running.' };
    }
    const client = (this.watcher as any).clients?.get('blackhole');
    if (client && typeof client.forceImport === 'function') {
      return client.forceImport(filename);
    }
    return { ok: false, message: 'Blackhole client not available.' };
  }

  async deleteWatchFile(filename: string): Promise<{ ok: boolean; message: string }> {
    if (!this.watcher) {
      return { ok: false, message: 'Watcher is not running.' };
    }
    const client = (this.watcher as any).clients?.get('blackhole');
    if (client && typeof client.deleteFile === 'function') {
      return client.deleteFile(filename);
    }
    return { ok: false, message: 'Blackhole client not available.' };
  }

  async countWatchFiles(): Promise<number> {
    if (!this.watcher) return 0;
    const client = (this.watcher as any).clients?.get('blackhole');
    if (client && typeof client.countWatchFolderFiles === 'function') {
      return client.countWatchFolderFiles();
    }
    return 0;
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
