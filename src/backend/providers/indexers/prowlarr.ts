import type {
  Indexer,
  IndexerInfo,
  IndexerProtocol,
  IndexerResult,
  RecentFeed,
  RecentOptions,
  SearchOptions,
} from './types';
import { logDebug } from '../../core/debug';
import { parseNewznabFeed, NewznabError } from './newznab';
import { db } from '../../db';

/**
 * Client for a Prowlarr instance's v1 API.
 *
 * Reference: https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json
 *
 * A few things about this API that are easy to get wrong:
 * - Auth is the `X-Api-Key` header, not a query param or bearer token.
 * - There is no `/api/v1/status` - system info lives at `/api/v1/system/status`.
 * - `/api/v1/search` is a GET with query params for actually searching;
 *   POSTing to it is how you *grab* a release, and the body must be the
 *   exact ReleaseResource object the GET returned (not just a guid).
 * - There's no separate "/api/v1/grab" endpoint.
 */
export class ProwlarrIndexer implements Indexer {
  name = 'Prowlarr';

  private baseUrl: string;

  constructor(
    private apiKey: string,
    baseUrl: string
  ) {
    // Guard against a trailing slash producing double-slashed paths
    // (`${baseUrl}${path}` below assumes no trailing slash on baseUrl).
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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
        `Could not reach Prowlarr at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.status === 401) {
      throw new Error('Prowlarr rejected the API key (401 Unauthorized).');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Prowlarr request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    // Some Prowlarr endpoints (e.g. bulk actions) return 200 with an empty body.
    const raw = await response.text();
    if (!raw) return undefined as T;
    return JSON.parse(raw) as T;
  }

  /**
   * Confirms the API key/URL actually work by hitting the real system-info
   * endpoint. `/api/v1/health` also works, but doesn't exist on all
   * versions and doesn't return a version string, so status is primary.
   */
  async validate(): Promise<{ ok: boolean; version?: string; message?: string }> {
    try {
      const status = await this.request<{ version: string; appName?: string }>('/api/v1/system/status');
      return { ok: true, version: status.version, message: `Connected to ${status.appName || 'Prowlarr'} v${status.version}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listIndexers(): Promise<IndexerInfo[]> {
    const indexers = await this.request<any[]>('/api/v1/indexer');
    return indexers.map(ix => ({
      id: ix.id,
      name: ix.name,
      enabled: ix.enable ?? true,
      categories: (ix.capabilities?.categories || []).map((c: any) => ({ id: c.id, name: c.name })),
      tags: ix.tags || [],
      priority: ix.priority ?? 0,
      privacy: ix.privacy ?? 'unknown',
      protocol: ix.protocol ?? 'unknown',
    }));
  }

  async search(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    const url = new URL(`${this.baseUrl}/api/v1/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('type', options?.type ?? 'search');
    if (options?.limit != null) url.searchParams.set('limit', String(options.limit));
    if (options?.offset != null) url.searchParams.set('offset', String(options.offset));
    for (const cat of options?.categories ?? []) url.searchParams.append('categories', String(cat));
    for (const id of options?.indexerIds ?? []) url.searchParams.append('indexerIds', String(id));

    const requestUrl = url.toString();

    logDebug({
      type: 'provider',
      level: 'info',
      source: 'Prowlarr',
      message: `Searching "${query}" (type=${options?.type ?? 'search'})`,
      url: requestUrl,
    });

    const response = await fetch(requestUrl, {
      headers: { 'X-Api-Key': this.apiKey },
    }).catch(err => {
      throw new Error(`Could not reach Prowlarr at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (response.status === 401) {
      throw new Error('Prowlarr rejected the API key (401 Unauthorized).');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Prowlarr search failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    const data = (await response.json()) as any[];

    logDebug({
      type: 'provider',
      level: data.length > 0 ? 'info' : 'debug',
      source: 'Prowlarr',
      message: `Search returned ${data.length} results for "${query}"`,
    });

    return data.map((item): IndexerResult => ({
      guid: item.guid,
      indexerId: item.indexerId,
      indexerName: item.indexer || this.name,
      title: item.title,
      seeders: item.seeders ?? 0,
      leechers: item.leechers ?? 0,
      grabs: item.grabs ?? 0,
      size: item.size ?? 0,
      publishDate: item.publishDate,
      ageHours: item.ageHours ?? 0,
      infoUrl: item.infoUrl ?? '',
      downloadUrl: item.downloadUrl ?? '',
      magnetUrl: item.magnetUrl ?? '',
      infoHash: item.infoHash ?? '',
      protocol: item.protocol ?? 'unknown',
      categories: (item.categories || []).map((c: any) => ({ id: c.id, name: c.name })),
      indexerFlags: item.indexerFlags || [],
      isPack: /\b(?:pack(?:s)?|complete|season)\b|\bS\d{1,2}\b(?!E)/i.test(item.title || ''),
      raw: item,
    }));
  }

  /**
   * RSS sync: each enabled Prowlarr indexer's latest-releases listing via
   * Prowlarr's per-indexer newznab/torznab proxy (`/{id}/api?t=tvsearch`
   * with no `q` - the same call Sonarr's RssSync makes). One feed per
   * indexer so each keeps its own cursor and a single broken tracker
   * doesn't hide the rest. Indexers whose caps list no TV category are
   * skipped. Falls back to `t=search` when an indexer rejects tvsearch.
   */
  async fetchRecent(options?: RecentOptions): Promise<RecentFeed[]> {
    const cats = options?.categories?.length ? options.categories : [5000, 5070];
    const indexers = (await this.listIndexers()).filter(ix =>
      ix.enabled && (ix.categories.length === 0 || ix.categories.some(c => c.id >= 5000 && c.id < 6000)),
    );
    const feeds: RecentFeed[] = [];
    for (const ix of indexers) {
      const key = `prowlarr:${ix.id}`;
      const protocol: IndexerProtocol = ix.protocol === 'usenet' || ix.protocol === 'torrent' ? ix.protocol : 'unknown';
      try {
        const parse = (xml: string) => parseNewznabFeed(xml, { indexerId: ix.id, indexerName: ix.name, protocol });
        let results: IndexerResult[];
        try {
          results = parse(await this.fetchNewznab(ix.id, 'tvsearch', cats, options?.limit));
        } catch (e) {
          // tvsearch unsupported -> newznab error (e.g. 202/203); retry plain search.
          if (!(e instanceof NewznabError)) throw e;
          results = parse(await this.fetchNewznab(ix.id, 'search', cats, options?.limit));
        }
        feeds.push({ key, name: ix.name, results });
      } catch (e) {
        feeds.push({ key, name: ix.name, results: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    return feeds;
  }

  private async fetchNewznab(indexerId: number, t: 'tvsearch' | 'search', cats: number[], limit?: number): Promise<string> {
    const url = new URL(`${this.baseUrl}/${indexerId}/api`);
    url.searchParams.set('t', t);
    url.searchParams.set('cat', cats.join(','));
    url.searchParams.set('extended', '1');
    if (limit != null) url.searchParams.set('limit', String(limit));
    logDebug({ type: 'provider', level: 'debug', source: 'Prowlarr', message: `RSS ${t} indexer=${indexerId}`, url: url.toString() });
    url.searchParams.set('apikey', this.apiKey);
    const res = await fetch(url.toString(), {
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(30_000),
    }).catch(err => {
      throw new Error(`Could not reach Prowlarr at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (res.status === 401) throw new Error('Prowlarr rejected the API key (401 Unauthorized).');
    if (!res.ok) throw new Error(`Prowlarr RSS ${t} failed for indexer ${indexerId}: ${res.status} ${res.statusText}`);
    return res.text();
  }

  /**
   * Grab for a release that didn't come from `/api/v1/search` (RSS feed
   * items have no ReleaseResource to POST back): hand the magnet or the
   * Prowlarr-proxied .torrent/.nzb straight to the blackhole folder, the
   * same way the native indexers do.
   */
  private async grabToBlackhole(release: IndexerResult): Promise<boolean> {
    let folder: string | null = null;
    try {
      const raw = db.getSetting('downloadClient');
      folder = raw ? JSON.parse(raw)?.blackhole?.outputFolder ?? null : null;
    } catch { folder = null; }
    if (!folder) {
      logDebug({ type: 'provider', level: 'warn', source: 'Prowlarr', message: `No blackhole output folder for feed release "${release.title}"` });
      return false;
    }
    const safe = release.title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    if (release.magnetUrl?.startsWith('magnet:')) {
      await Bun.file(`${folder}/${release.infoHash || safe}.magnet`).write(release.magnetUrl);
      return true;
    }
    if (!release.downloadUrl) return false;
    const res = await fetch(release.downloadUrl, { headers: { 'X-Api-Key': this.apiKey }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    const ext = release.protocol === 'usenet' || (res.headers.get('Content-Type') ?? '').includes('nzb') ? '.nzb' : '.torrent';
    await Bun.file(`${folder}/${safe}${ext}`).write(Buffer.from(await res.arrayBuffer()));
    return true;
  }

  /**
   * Grabs a release. Prowlarr's search endpoint doubles as the grab
   * endpoint: POSTing the exact ReleaseResource back triggers Prowlarr to
   * send it to whichever download client is configured for the release's
   * protocol (or the one mapped to that indexer).
   *
   * This requires at least one Download Client to be configured in
   * Prowlarr itself (Settings > Download Clients) - Prowlarr is the one
   * doing the actual handoff here, not this app.
   */
  async grab(release: IndexerResult): Promise<boolean> {
    try {
      if (!release.raw) return await this.grabToBlackhole(release);
      logDebug({
        type: 'provider',
        level: 'info',
        source: 'Prowlarr',
        message: `POST grab for "${release.title}" (${release.guid})`,
        url: `${this.baseUrl}/api/v1/search`,
      });
      await this.request('/api/v1/search', {
        method: 'POST',
        body: JSON.stringify(release.raw),
      });
      return true;
    } catch (err) {
      logDebug({
        type: 'provider',
        level: 'error',
        source: 'Prowlarr',
        message: `Grab failed for "${release.title}"`,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Fetches the raw release file (.torrent/.nzb) bytes directly from
   * Prowlarr, bypassing Prowlarr's own Download Client integration. Useful
   * if this app wants to hand the file to its own download pipeline (e.g.
   * a blackhole watch folder) instead of relying on a download client being
   * configured inside Prowlarr.
   */
  async fetchReleaseFile(release: IndexerResult): Promise<{ data: ArrayBuffer; contentType: string | null } | null> {
    if (!release.downloadUrl) return null;
    const url = new URL(`${this.baseUrl}/api/v1/indexer/${release.indexerId}/download`);
    url.searchParams.set('link', release.downloadUrl);
    const response = await fetch(url.toString(), { headers: { 'X-Api-Key': this.apiKey } });
    if (!response.ok) return null;
    return { data: await response.arrayBuffer(), contentType: response.headers.get('Content-Type') };
  }
}
