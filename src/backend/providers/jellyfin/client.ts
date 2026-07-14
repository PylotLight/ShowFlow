// Jellyfin API Client
// Docs: https://api.jellyfin.org/#tag/UserData

export interface JellyfinUser {
  Id: string;
  Name: string;
  LastActivityDate: string;
  LastLoginDate: string;
  IsAdministrator: boolean;
}

export interface JellyfinProviderIds {
  Tvdb?: string;
  Tmdb?: string;
  Imdb?: string;
  TvMaze?: string;
}

export interface JellyfinUserData {
  Played: boolean;
  PlayedPercentage: number | null;
  LastPlayedDate: string | null;
  PlayCount: number;
  IsFavorite: boolean;
  ItemId: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  SeriesName: string;
  SeriesId: string;
  IndexNumber: number | null;
  ParentIndexNumber: number | null;
  SeasonId: string;
  ProviderIds: JellyfinProviderIds;
  UserData: JellyfinUserData;
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}

export interface JellyfinSystemInfo {
  Version: string;
  ServerName: string;
  OperatingSystem: string;
}

export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          'Authorization': `MediaBrowser Token="${this.apiKey}"`,
          'Accept': 'application/json',
        },
      });
    } catch (err) {
      throw new Error(
        `Could not reach Jellyfin at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.status === 401) {
      throw new Error('Jellyfin rejected the API key (401 Unauthorized).');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Jellyfin request failed: ${response.status}${text ? ` - ${text}` : ''}`);
    }

    return response.json() as Promise<T>;
  }

  async test(): Promise<{ ok: boolean; version?: string; serverName?: string; message?: string }> {
    try {
      const info = await this.request<JellyfinSystemInfo>('/System/Info');
      return { ok: true, version: info.Version, serverName: info.ServerName };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async getUsers(): Promise<JellyfinUser[]> {
    return this.request<JellyfinUser[]>('/Users');
  }

  async getWatchedEpisodes(userId: string): Promise<JellyfinItem[]> {
    const query = new URLSearchParams({
      IncludeItemTypes: 'Episode',
      Recursive: 'true',
      IsPlayed: 'true',
      Fields: 'ProviderIds,UserData',
      SortBy: 'SortName',
    });
    const res = await this.request<JellyfinItemsResponse>(`/Users/${userId}/Items?${query}`);
    return res.Items || [];
  }

  async getAllEpisodes(userId: string): Promise<JellyfinItem[]> {
    const query = new URLSearchParams({
      IncludeItemTypes: 'Episode',
      Recursive: 'true',
      Fields: 'ProviderIds,UserData',
      SortBy: 'SortName',
    });
    const res = await this.request<JellyfinItemsResponse>(`/Users/${userId}/Items?${query}`);
    return res.Items || [];
  }

  async getSeriesBatch(seriesIds: string[], userId: string): Promise<Map<string, JellyfinProviderIds>> {
    const result = new Map<string, JellyfinProviderIds>();
    if (seriesIds.length === 0) return result;

    // Fetch series in chunks to avoid overly long URLs
    const chunkSize = 50;
    for (let i = 0; i < seriesIds.length; i += chunkSize) {
      const chunk = seriesIds.slice(i, i + chunkSize);
      const query = new URLSearchParams({
        Ids: chunk.join(','),
        Fields: 'ProviderIds',
        Recursive: 'false',
      });
      try {
        const res = await this.request<JellyfinItemsResponse>(`/Users/${userId}/Items?${query}`);
        for (const item of res.Items || []) {
          result.set(item.Id, item.ProviderIds || {});
        }
      } catch (err) {
        console.error(`[jellyfin] Failed to fetch series batch: ${err}`);
      }
    }
    return result;
  }
}
