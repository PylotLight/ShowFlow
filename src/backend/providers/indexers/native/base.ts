import type {
  Indexer,
  IndexerInfo,
  IndexerResult,
  SearchOptions,
} from '../types';
import type { NativeIndexerId } from './types';
import { NATIVE_INDEXER_META } from './types';
import { db } from '../../../db';
import { logDebug } from '../../../core/debug';

export abstract class BaseNativeIndexer implements Indexer {
  abstract name: string;

  protected readonly id: NativeIndexerId;
  protected readonly baseUrl: string;
  protected readonly rateLimit: number;
  private lastRequestTime = 0;

  constructor(id: NativeIndexerId, baseUrl?: string, rateLimit = 1500) {
    this.id = id;
    this.baseUrl = (baseUrl ?? NATIVE_INDEXER_META[id].defaultUrl).replace(/\/+$/, '');
    this.rateLimit = rateLimit;
  }

  /**
   * Enforce per-tracker rate limiting.
   */
  protected async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimit) {
      await new Promise(r => setTimeout(r, this.rateLimit - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch HTML text from a URL with basic error handling.
   */
  protected async fetchHtml(url: string): Promise<string> {
    logDebug({ type: 'provider', level: 'debug', source: this.name, message: `GET ${url}`, url });
    await this.throttle();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ShowFlow/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${this.name} returned ${res.status} for ${url}`);
    }
    return res.text();
  }

  /**
   * Fetch XML/RSS text from a URL.
   */
  protected async fetchRss(url: string): Promise<string> {
    logDebug({ type: 'provider', level: 'debug', source: this.name, message: `RSS GET ${url}`, url });
    await this.throttle();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ShowFlow/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${this.name} RSS returned ${res.status} for ${url}`);
    }
    return res.text();
  }

  /**
   * Fetch JSON from a URL.
   */
  protected async fetchJson<T = any>(url: string): Promise<T> {
    logDebug({ type: 'provider', level: 'debug', source: this.name, message: `JSON GET ${url}`, url });
    await this.throttle();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ShowFlow/1.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${this.name} API returned ${res.status} for ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * POST JSON to a URL and parse the JSON response.
   */
  protected async fetchPostJson<T = any>(url: string, body: Record<string, unknown>): Promise<T> {
    logDebug({
      type: 'provider', level: 'debug', source: this.name,
      message: `POST ${url}`,
      url,
      requestBody: body,
    });
    await this.throttle();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ShowFlow/1.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${this.name} API returned ${res.status} for POST ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Subclasses implement the actual search logic.
   */
  protected abstract doSearch(query: string, options?: SearchOptions): Promise<IndexerResult[]>;

  async search(query: string, options?: SearchOptions): Promise<IndexerResult[]> {
    try {
      logDebug({
        type: 'provider',
        level: 'info',
        source: this.name,
        message: `Searching "${query}"`,
        url: `${this.baseUrl}/?q=${encodeURIComponent(query)}`,
      });
      const results = await this.doSearch(query, options);
      logDebug({
        type: 'provider',
        level: results.length > 0 ? 'info' : 'debug',
        source: this.name,
        message: `Found ${results.length} results for "${query}"`,
      });
      return results;
    } catch (err) {
      logDebug({
        type: 'provider', level: 'error', source: this.name,
        message: `Search error for "${query}"`,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Validate that the tracker is reachable. Subclasses may override to
   * use a more specific health-check endpoint.
   */
  async validate(): Promise<{ ok: boolean; version?: string; message?: string }> {
    try {
      const result = await this.doValidate();
      return result;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Per-tracker validation logic. Defaults to fetching the homepage.
   */
  protected async doValidate(): Promise<{ ok: boolean; version?: string; message?: string }> {
    const html = await this.fetchHtml(this.baseUrl);
    const ok = html.length > 200;
    return {
      ok,
      version: '1.0',
      message: ok ? `${this.name} is reachable` : `${this.name} returned empty response`,
    };
  }

  /**
   * List self as an indexer (native indexers are singleton trackers).
   */
  async listIndexers(): Promise<IndexerInfo[]> {
    const meta = NATIVE_INDEXER_META[this.id];
    return [{
      id: 1,
      name: this.name,
      enabled: true,
      categories: [
        { id: 5000, name: 'TV' },
        { id: 5070, name: 'Anime' },
      ],
      tags: [],
      priority: 0,
      privacy: meta.privacy,
      protocol: meta.protocol,
    }];
  }

  /**
   * Download a torrent file from the release's download/magnet URL and
   * write it to the configured blackhole output folder so the user's
   * download client can pick it up.
   */
  async grab(release: IndexerResult): Promise<boolean> {
    try {
      const url = release.magnetUrl || release.downloadUrl;
      if (!url) {
        logDebug({ type: 'provider', level: 'warn', source: this.name, message: `No download URL for "${release.title}"` });
        return false;
      }

      logDebug({
        type: 'provider', level: 'info', source: this.name,
        message: `Downloading "${release.title}" from ${url.startsWith('magnet:') ? 'magnet' : 'HTTP'}`,
      });

      if (url.startsWith('magnet:')) {
        const outputFolder = this.getBlackholeFolder();
        if (!outputFolder) return false;
        const hash = url.match(/btih:([a-fA-F0-9]+)/)?.[1] || crypto.randomUUID();
        const magnetFile = `${outputFolder}/${hash}.magnet`;
        await Bun.file(magnetFile).write(url);
        return true;
      }

      await this.throttle();
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ShowFlow/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return false;

      const buf = await res.arrayBuffer();
      const outputFolder = this.getBlackholeFolder();
      if (!outputFolder) return false;

      const name = release.title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const ext = res.headers.get('Content-Type')?.includes('application/x-bittorrent') ? '.torrent' : '.torrent';
      const filePath = `${outputFolder}/${name}${ext}`;
      await Bun.file(filePath).write(Buffer.from(buf));
      return true;
    } catch (err) {
      logDebug({
        type: 'provider', level: 'error', source: this.name,
        message: `Grab failed for "${release.title}"`,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  protected blackholeFolder: string | null = null;

  setBlackholeFolder(folder: string | null): void {
    this.blackholeFolder = folder;
  }

  private getBlackholeFolder(): string | null {
    if (this.blackholeFolder) return this.blackholeFolder;
    try {
      const raw = db.getSetting('downloadClient');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.blackhole?.outputFolder ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Escape text for use in a regex character class.
   */
  protected escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Extract a value from HTML using a regex and return the trimmed match.
   */
  protected extractHtmlValue(html: string | undefined, pattern: RegExp, group = 1): string {
    if (!html) return '';
    const match = html.match(pattern);
    return match?.[group]?.trim() ?? '';
  }

  /**
   * Parse byte size from human-readable string (e.g. "2.5 GiB", "750 MB").
   */
  protected parseSize(sizeStr: string | undefined): number {
    if (!sizeStr) return 0;
    const match = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]!);
    if (Number.isNaN(num)) return 0;
    const unit = (match[2] || 'B').toUpperCase();
    const units: Record<string, number> = { B: 1, KB: 1e3, KIB: 1e3, MB: 1e6, MIB: 1e6, GB: 1e9, GIB: 1e9, TB: 1e12, TIB: 1e12 };
    return Math.round(num * (units[unit] ?? 1));
  }

  /**
   * Parse age string into hours (e.g. "5 days", "2 hours", "Today", "Yesterday").
   */
  protected parseAgeToHours(ageStr: string | undefined): number {
    if (!ageStr) return 0;
    const s = ageStr.trim().toLowerCase();
    if (s.includes('today') || s.includes('just now') || s.includes('now')) return 0;
    if (s.includes('yesterday')) return 24;
    const numMatch = s.match(/(\d+)\s*(min|hour|day|week|month|year)/);
    if (!numMatch) return 0;
    const num = parseInt(numMatch[1]!, 10);
    const unit = numMatch[2]!;
    switch (unit) {
      case 'min': return num / 60;
      case 'hour': return num;
      case 'day': return num * 24;
      case 'week': return num * 168;
      case 'month': return num * 720;
      case 'year': return num * 8760;
      default: return 0;
    }
  }

  /**
   * Compute age in hours from an ISO date string.
   */
  protected ageFromIso(iso: string | undefined): number {
    if (!iso) return 0;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 0;
    return (Date.now() - then) / 3_600_000;
  }

  /**
   * Determine if a title looks like a pack/season/complete release.
   */
  protected isPack(title: string): boolean {
    return /\b(?:pack(?:s)?|complete|season)\b|全集|全話|\bS\d{1,2}\b(?!E)/i.test(title);
  }
}
