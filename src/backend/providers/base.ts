import { limiter } from '../core/limiter';
import { db } from '../db';

export abstract class BaseProvider {
  abstract name: string;
  abstract searchShow(query: string): Promise<any[]>;
  abstract getShow(id: string): Promise<any>;
  abstract getEpisode(showId: string, episodeInfo: any): Promise<any>;
  abstract getSeasons(showId: string): Promise<any[]>;
  abstract getEpisodes(showId: string, seasonNumber?: number): Promise<any[]>;
  protected abstract readonly apiBaseUrl: string;
  protected apiKey: string = '';

  constructor(protected config: any = {}) {}

  /**
    * Builds a stable cache key for a request. Overridden by providers whose
   * "endpoint" doesn't uniquely identify the request (e.g. GraphQL, where the
   * query lives in the body).
   */
  protected cacheKey(endpoint: string, options: RequestInit = {}): string {
    return `${this.name}:${endpoint}:${options.body ?? ''}`;
  }

  protected async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const key = this.cacheKey(endpoint, options);
    const cached = db.getCache<T>(key);
    if (cached !== null) return cached;

    await limiter.acquire();

    const url = `${this.apiBaseUrl}${endpoint}`;

    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      ...options,
      headers,
    });
    if (response.status === 401) {
      console.error(`[DEBUG] 401 Unauthorized for ${url}. Headers:`, Object.fromEntries(headers.entries()));
    }

    if (response.status === 429) {
      // Simple retry for rate limits if the global limiter missed it
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 1000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.fetch(endpoint, options);
    }

    if (!response.ok) {
      throw new Error(`API Request failed: ${response.status} ${response.statusText} - ${url}`);
    }

    const json = (await response.json()) as T;
    db.setCache(key, json);
    return json;
  }
}
