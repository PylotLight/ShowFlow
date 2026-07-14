// Sonarr v3/v4/v5 API Client
// Reference: https://sonarr.tv/docs/api

export interface SonarrSeries {
  id: number;
  title: string;
  alternateTitles: { title: string; seasonNumber?: number }[];
  sortTitle: string;
  status: "continuing" | "ended" | "upcoming" | "deleted";
  ended: boolean;
  overview: string | null;
  network: string | null;
  airTime: string | null;
  images: { coverType: string; url: string; remoteUrl: string }[];
  seasons: { seasonNumber: number; monitored: boolean; statistics?: { episodeCount: number; episodeFileCount: number; totalEpisodeCount: number } }[];
  year: number;
  path: string;
  qualityProfileId: number;
  seasonFolder: boolean;
  monitored: boolean;
  useSceneNumbering: boolean;
  runtime: number;
  tvdbId: number;
  tvRageId: number;
  tvMazeId: number;
  tmdbId: number;
  /** v5+ */
  malIds?: number[];
  /** v5+ */
  aniListIds?: number[];
  firstAired: string | null;
  seriesType: "standard" | "daily" | "anime";
  cleanTitle: string;
  imdbId: string | null;
  titleSlug: string;
  rootFolderPath: string;
  added: string;
  ratings: { votes: number; value: number };
  statistics: {
    seasonCount: number;
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
    sizeOnDisk: number;
  };
  genres: string[];
  tags: number[];
  /** v5+ */
  originalCountry?: string | null;
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  tvdbId: number;
  episodeFileId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  airDateUtc: string | null;
  runtime: number;
  overview: string | null;
  hasFile: boolean;
  monitored: boolean;
  absoluteEpisodeNumber: number | null;
  sceneEpisodeNumber: number | null;
  sceneSeasonNumber: number | null;
  episodeFile?: SonarrEpisodeFile;
}

export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  relativePath: string | null;
  path: string | null;
  size: number;
  dateAdded: string;
  sceneName: string | null;
  releaseGroup: string | null;
  quality: {
    quality: { id: number; name: string; source: string; resolution: number };
    revision: { version: number; real: number; isRepack: boolean };
  };
}

export interface SonarrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace: number;
  totalSpace: number;
}

export interface SonarrQualityProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: { quality: { id: number; name: string }; allowed: boolean }[];
}

export interface SonarrTag {
  id: number;
  label: string;
}

export class SonarrClient {
  private baseUrl: string;
  private apiKey: string;
  private apiPrefix: string;

  constructor(baseUrl: string, apiKey: string, apiVersion: 'v3' | 'v5' = 'v3') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.apiPrefix = `/api/${apiVersion}`;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...options,
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      });
    } catch (err) {
      throw new Error(
        `Could not reach Sonarr at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.status === 401) {
      throw new Error('Sonarr rejected the API key (401 Unauthorized).');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Sonarr request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    return response.json() as Promise<T>;
  }

  async test(): Promise<{ ok: boolean; version?: string; message?: string }> {
    try {
      const info = await this.request<{ version: string; appName?: string; instanceName?: string }>(`${this.apiPrefix}/system/status`);
      return { ok: true, version: info.version };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async getSeries(): Promise<SonarrSeries[]> {
    return this.request<SonarrSeries[]>(`${this.apiPrefix}/series`);
  }

  async getSeriesById(id: number): Promise<SonarrSeries> {
    return this.request<SonarrSeries>(`${this.apiPrefix}/series/${id}`);
  }

  async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    return this.request<SonarrEpisode[]>(`${this.apiPrefix}/episode?seriesId=${seriesId}`);
  }

  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    return this.request<SonarrEpisodeFile[]>(`${this.apiPrefix}/episodefile?seriesId=${seriesId}`);
  }

  async getRootFolders(): Promise<SonarrRootFolder[]> {
    return this.request<SonarrRootFolder[]>(`${this.apiPrefix}/rootfolder`);
  }

  async getQualityProfiles(): Promise<SonarrQualityProfile[]> {
    return this.request<SonarrQualityProfile[]>(`${this.apiPrefix}/qualityprofile`);
  }

  async getTags(): Promise<SonarrTag[]> {
    return this.request<SonarrTag[]>(`${this.apiPrefix}/tag`);
  }
}
