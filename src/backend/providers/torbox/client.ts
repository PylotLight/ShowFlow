export interface TorboxClientConfig {
  apiKey: string;
  baseUrl: string;
}

export interface CreateTorrentOptions {
  file?: Blob | File;
  magnet?: string;
  seed?: 1 | 2 | 3;
  allowZip?: boolean;
  name?: string;
  asQueued?: boolean;
  addOnlyIfCached?: boolean;
}

export interface DownloadRequestOptions {
  torrentId: string;
  fileId?: string;
  zipLink?: string;
  userIp?: string;
  redirect?: string;
  appendName?: string;
}

export class TorboxClient {
  constructor(private config: TorboxClientConfig) {}

  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    if (!(options.body instanceof FormData)) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      };
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TorBox API Error (${response.status}): ${errorText}`);
    }
    return response.json();
  }

  async createTorrent(options: CreateTorrentOptions) {
    const formData = new FormData();
    if (options.file) formData.append('file', options.file, 'file');
    if (options.magnet) formData.append('magnet', options.magnet);
    if (options.seed) formData.append('seed', options.seed.toString());
    if (options.allowZip !== undefined) formData.append('allow_zip', String(options.allowZip));
    if (options.name) formData.append('name', options.name);
    if (options.asQueued !== undefined) formData.append('as_queued', String(options.asQueued));
    if (options.addOnlyIfCached !== undefined) formData.append('add_only_if_cached', String(options.addOnlyIfCached));
    return this.request<any>('/v1/api/torrents/createtorrent', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      body: formData,
    });
  }

  async requestDownloadLink(options: DownloadRequestOptions) {
    const params: Record<string, string> = {
      token: this.config.apiKey,
      torrent_id: options.torrentId,
    };
    if (options.fileId !== undefined) params.file_id = options.fileId;
    if (options.zipLink !== undefined) params.zip_link = String(options.zipLink);
    if (options.userIp !== undefined) params.user_ip = options.userIp;
    if (options.redirect !== undefined) params.redirect = String(options.redirect);
    if (options.appendName !== undefined) params.append_name = String(options.appendName);
    const query = new URLSearchParams(params);
    return this.request<any>(`/v1/api/torrents/requestdl?${query.toString()}`, {
      method: 'GET',
    });
  }

  async getTorrentStatus(torrentId: string, bypassCache = true) {
    const query = new URLSearchParams({
      id: torrentId,
      bypass_cache: bypassCache ? 'true' : 'false',
    });
    return this.request<any>(`/v1/api/torrents/mylist?${query.toString()}`, {
      method: 'GET',
    });
  }

  /** Lightweight credential/connectivity check - used by the health poller, not the download flow. */
  async getUserInfo() {
    return this.request<any>('/v1/api/user/me', { method: 'GET' });
  }
}
