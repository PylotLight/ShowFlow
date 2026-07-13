import { LibraryScanner } from '../core/library_scanner';
import { DownloadManager } from '../core/download_manager';
import { db, type Config } from '../db';

export class SystemManager {
  private config: Config;
  private watcher: DownloadManager | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async scan() {
    const scanner = new LibraryScanner(this.config);
    return await scanner.scan();
  }

  async startWatcher() {
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

  async rescanWatcher() {
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
}
