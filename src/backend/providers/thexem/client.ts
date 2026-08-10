import { db } from '../../db';

const THEXEM_BASE = 'https://thexem.info';

export interface XemBlock {
  season: number;
  episode: number;
  absolute: number;
}

export interface XemEntry {
  scene?: XemBlock;
  anidb?: XemBlock;
  tvdb?: XemBlock;
  [provider: string]: XemBlock | undefined;
}

export interface XemMappingAllResponse {
  result: string;
  data?: XemEntry[] | Record<string, XemEntry[]>;
  message?: string;
}

function getCacheTtl(resp: Response): number {
  const cc = resp.headers.get('Cache-Control') ?? '';
  const maxAge = /max-age=(\d+)/.exec(cc)?.[1];
  // TheXem explicitly permits long client-side caching; default to 7 days
  // (604800s) when the header is absent. When Cloudflare gives a short
  // max-age (e.g. 3600) we still keep a week-long floor so a host outage
  // doesn't immediately invalidate the only copy of the mapping.
  const fromHeader = maxAge ? parseInt(maxAge, 10) * 1000 : 0;
  const floor = 7 * 24 * 60 * 60 * 1000;
  return Math.max(fromHeader, floor);
}

/**
 * Minimal TheXem client (https://thexem.info/doc). TheXem is the canonical
 * cross-provider anime episode mapping: it knows scene numbering, which is
 * what release groups actually use, and how each scene S/E maps onto
 * AniDB's and TVDB's numbering (issues-tracking.md #4).
 *
 * Response shape for /map/all?id={tvdbId}&origin=tvdb (verified live):
 *   { "result":"success", "data":[ {scene:{season,episode,absolute},
 *     anidb:{...}, tvdb:{...}}, ... ] }
 *
 * Honzuki (tvdb 366263) confirms the real-world split the feature exists
 * for: scene/anidb use S01-S04 while tvdb collapses everything into S01
 * (scene S04E17 -> tvdb S01E53).
 */
export class TheXemClient {
  name = 'thexem';

  private async fetchJson(url: string, cacheKey: string): Promise<XemMappingAllResponse> {
    const cached = db.getCache<XemMappingAllResponse>(cacheKey);
    if (cached !== null) return cached;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Bun's native connect/timeout error is opaque; surface the target URL
      // so a DNS sinkhole or network block is obvious to the caller.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`TheXem request to ${url} failed: ${message}`);
    }

    if (!resp.ok) {
      throw new Error(`TheXem request failed: ${resp.status} ${resp.statusText} (${url})`);
    }

    const json = (await resp.json()) as XemMappingAllResponse;
    db.setCache(cacheKey, json, getCacheTtl(resp));
    return json;
  }

  /**
   * Full episode map for a TVDB id. Returns an array of scene/anidb/tvdb
   * entries, or `null` when TheXem has no entry for the id.
   */
  async getMappingAll(tvdbId: string | number): Promise<XemEntry[] | null> {
    const url = `${THEXEM_BASE}/map/all?id=${encodeURIComponent(String(tvdbId))}&origin=tvdb`;
    const json = await this.fetchJson(url, `thexem:all:${tvdbId}`);

    if (json.result !== 'success') {
      if (json.message && /no show|doesn't have|does not have|unknown/i.test(json.message)) {
        return null;
      }
      throw new Error(`TheXem map/all failed: ${json.message ?? json.result}`);
    }

    if (Array.isArray(json.data)) return json.data;

    if (json.data && typeof json.data === 'object') {
      const entries = json.data[String(tvdbId)];
      if (Array.isArray(entries)) return entries;
    }

    return null;
  }
}

export const thexemClient = new TheXemClient();