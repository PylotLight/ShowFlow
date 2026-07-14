import { db, type Config } from '../db';
import { BlackholeClient, TorboxDownloadClient, resolveTorboxConfig, type DownloadClient } from './download_clients';
import { debugLog } from './debug';

export class DownloadManager {
  private clients: Map<string, DownloadClient> = new Map();

  constructor(private config: Config) {}

  async start() {
    debugLog('Starting Download Manager');

    const dc = this.config.downloadClient;

    if (dc.blackhole?.watchFolder || dc.blackhole?.outputFolder) {
      const client = new BlackholeClient(this.config);
      this.clients.set('blackhole', client);
      await client.start();
    }

    if (dc.torbox?.apiKey) {
      const client = new TorboxDownloadClient(resolveTorboxConfig(this.config));
      this.clients.set('torbox', client);
      await client.start();
    }
  }

  async stop() {
    debugLog('Stopping Download Manager');
    for (const client of this.clients.values()) {
      await client.stop();
    }
  }

  /**
   * Files/releases actively in flight across every configured download
   * path - Blackhole's local watch-folder backlog plus anything currently
   * being cached/downloaded via TorBox - so the Queue page reflects the
   * real picture regardless of which client is doing the work.
   */
  getProcessingFiles(): string[] {
    const blackhole = this.clients.get('blackhole') as BlackholeClient | undefined;
    const torbox = this.clients.get('torbox') as TorboxDownloadClient | undefined;
    const local = blackhole ? blackhole.getProcessingFiles() : [];
    const remote = torbox ? torbox.getActiveDownloads().map(t => `[TorBox] ${t}`) : [];
    return [...local, ...remote];
  }

  getTorboxClient(): TorboxDownloadClient | undefined {
    return this.clients.get('torbox') as TorboxDownloadClient | undefined;
  }

  /**
   * Submit a release directly to TorBox, bypassing the blackhole folder's
   * .torrent/.magnet hand-off. Resolves once TorBox has accepted the
   * torrent - the download itself continues in the background and is
   * tracked via db events (see TorboxDownloadClient.submitReleaseBackground).
   */
  async grabWithTorbox(release: { magnetUrl?: string; downloadUrl?: string; infoHash?: string; title: string }): Promise<{ ok: boolean; message: string }> {
    const torbox = this.getTorboxClient();
    if (!torbox) return { ok: false, message: 'TorBox is not configured or not running' };
    return torbox.submitReleaseBackground(release);
  }
}
