import { TorboxClient } from './client';
import type { TorboxClientConfig } from './client';

export class TorboxService {
  private client: TorboxClient;

  constructor(config: TorboxClientConfig) {
    this.client = new TorboxClient(config);
  }

  async addTorrent(options: Parameters<TorboxClient['createTorrent']>[0]) {
    try {
      const result = await this.client.createTorrent(options);
      return { success: true, result };
    } catch (error) {
      console.error('[TorboxService] Failed to add torrent:', error);
      return { success: false, error };
    }
  }

  async getStatus(torrentId: string) {
    try {
      const result = await this.client.getTorrentStatus(torrentId);
      return { success: true, result };
    } catch (error) {
      console.error(`[TorboxService] Failed to get status for ${torrentId}:`, error);
      return { success: false, error };
    }
  }

  async requestDownload(options: Parameters<TorboxClient['requestDownloadLink']>[0]) {
    try {
      const result = await this.client.requestDownloadLink(options);
      return { success: true, result };
    } catch (error) {
      console.error(`[TorboxService] Failed to request download link for ${options.torrentId}:`, error);
      return { success: false, error };
    }
  }
}
