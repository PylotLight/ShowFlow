import { db, type Config } from '../db';
import { BlackholeClient, type DownloadClient } from './download_clients';
import { debugLog } from './debug';

export class DownloadManager {
  private clients: Map<string, DownloadClient> = new Map();

  constructor(private config: Config) {}

  async start() {
    debugLog('Starting Download Manager');
    
    if (this.config.downloadClient.type === 'blackhole') {
      const client = new BlackholeClient(this.config);
      this.clients.set('blackhole', client);
      await client.start();
    }

    // Other clients will be added here (e.g. qBittorrent, Transmission)
  }

  async stop() {
    debugLog('Stopping Download Manager');
    for (const client of this.clients.values()) {
      await client.stop();
    }
  }

  getProcessingFiles(): string[] {
    const client = this.clients.get('blackhole') as BlackholeClient | undefined;
    return client ? client.getProcessingFiles() : [];
  }
}
