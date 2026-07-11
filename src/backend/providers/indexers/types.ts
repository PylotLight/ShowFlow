export type IndexerProtocol = 'usenet' | 'torrent' | 'unknown';

export interface IndexerCategory {
  id: number;
  name: string;
}

export interface IndexerResult {
  /** Prowlarr's release GUID - required to grab this specific release. */
  guid: string;
  /** Which Prowlarr-configured indexer this release came from. */
  indexerId: number;
  indexerName: string;
  title: string;
  seeders: number;
  leechers: number;
  grabs: number;
  size: number;
  /** ISO date string. */
  publishDate: string;
  ageHours: number;
  infoUrl: string;
  downloadUrl: string;
  magnetUrl: string;
  infoHash: string;
  protocol: IndexerProtocol;
  categories: IndexerCategory[];
  indexerFlags: string[];
  isPack: boolean;
  /**
   * The exact ReleaseResource JSON Prowlarr returned for this release.
   * Grabbing requires POSTing this object back verbatim - Prowlarr doesn't
   * grab by GUID alone.
   */
  raw: Record<string, unknown>;
}

export interface IndexerInfo {
  id: number;
  name: string;
  enabled: boolean;
  categories: IndexerCategory[];
  tags: number[];
  priority: number;
  privacy: string;
  protocol: string;
}

/** Mirrors Prowlarr's search "type" values (Query.Type in Cardigann). */
export type SearchType = 'search' | 'tvsearch' | 'movie' | 'music' | 'book';

export interface SearchOptions {
  type?: SearchType;
  /** Prowlarr category IDs, e.g. 5000 for TV, 2000 for Movies. */
  categories?: number[];
  /** Restrict the search to specific Prowlarr-configured indexers. */
  indexerIds?: number[];
  limit?: number;
  offset?: number;
}

export interface Indexer {
  name: string;
  search(query: string, options?: SearchOptions): Promise<IndexerResult[]>;
  /** Grabs a specific release previously returned by search(). */
  grab(release: IndexerResult): Promise<boolean>;
  validate(): Promise<{ ok: boolean; version?: string; message?: string }>;
  listIndexers(): Promise<IndexerInfo[]>;
}
