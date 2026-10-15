import path from 'node:path';
import type { PlexSection } from '../../providers/plex/client';

/**
 * Post-import media-server refresh (Jellyfin + Plex), debounced.
 *
 * Imports land one file at a time; a season pack is ten import_completed
 * events within seconds. The queue collects paths and fires once the stream
 * goes quiet for `windowMs` (capped at `maxWaitMs` so a long trickle still
 * refreshes), with one targeted call per unique folder.
 */

export interface PathMap { from: string; to: string }

/** Rewrite a ShowFlow path into the media server's view of it (prefix swap). */
export function mapPath(p: string, map?: PathMap | null): string {
  if (!map || !map.from) return p;
  const from = map.from.replace(/[\\/]+$/, '');
  if (p === from || p.startsWith(`${from}/`) || p.startsWith(`${from}\\`)) {
    return map.to.replace(/[\\/]+$/, '') + p.slice(from.length);
  }
  return p;
}

/** Folder to rescan for an imported file (its parent: the season/movie folder). */
export function refreshDirFor(filePath: string): string {
  return path.posix.dirname(filePath.replace(/\\/g, '/'));
}

const isUnder = (child: string, parent: string) => {
  const p = parent.replace(/\/+$/, '');
  return child === p || child.startsWith(`${p}/`);
};

/** The Plex section whose library folder contains the path (longest prefix wins). */
export function pickPlexSection(sections: PlexSection[], dir: string): PlexSection | null {
  let best: { s: PlexSection; len: number } | null = null;
  for (const s of sections) {
    for (const loc of s.locations) {
      if (isUnder(dir, loc) && (!best || loc.length > best.len)) best = { s, len: loc.length };
    }
  }
  return best?.s ?? null;
}

export interface JellyfinRefresher {
  notifyMediaUpdated(paths: string[]): Promise<void>;
  refreshLibrary(): Promise<void>;
}
export interface PlexRefresher {
  getSections(): Promise<PlexSection[]>;
  refreshSection(key: string, path?: string): Promise<void>;
}

export interface MediaTargets {
  jellyfin?: { client: JellyfinRefresher; pathMap?: PathMap } | null;
  plex?: { client: PlexRefresher; pathMap?: PathMap } | null;
}

export interface RefreshRun {
  at: string;
  dirs: string[];
  jellyfin?: { mode: 'targeted' | 'full'; ok: boolean; error?: string };
  plex?: { ok: boolean; refreshed: { section: string; path: string }[]; unmatched: string[]; error?: string };
}

/** Do one refresh for a set of imported folders. Exported for tests. */
export async function runRefresh(dirs: string[], targets: MediaTargets, now = new Date()): Promise<RefreshRun> {
  const unique = [...new Set(dirs)].sort();
  const run: RefreshRun = { at: now.toISOString(), dirs: unique };

  if (targets.jellyfin) {
    const { client, pathMap } = targets.jellyfin;
    const mapped = [...new Set(unique.map(d => mapPath(d, pathMap)))];
    try {
      await client.notifyMediaUpdated(mapped);
      run.jellyfin = { mode: 'targeted', ok: true };
    } catch (err) {
      const targetedErr = err instanceof Error ? err.message : String(err);
      try {
        await client.refreshLibrary();
        run.jellyfin = { mode: 'full', ok: true, error: `targeted failed (${targetedErr}), ran full scan` };
      } catch (err2) {
        run.jellyfin = { mode: 'full', ok: false, error: err2 instanceof Error ? err2.message : String(err2) };
      }
    }
  }

  if (targets.plex) {
    const { client, pathMap } = targets.plex;
    const result: NonNullable<RefreshRun['plex']> = { ok: true, refreshed: [], unmatched: [] };
    try {
      const sections = await client.getSections();
      for (const dir of [...new Set(unique.map(d => mapPath(d, pathMap)))]) {
        const section = pickPlexSection(sections, dir);
        if (!section) { result.unmatched.push(dir); continue; }
        await client.refreshSection(section.key, dir);
        result.refreshed.push({ section: section.title || section.key, path: dir });
      }
      if (result.unmatched.length && !result.refreshed.length) {
        result.ok = false;
        result.error = 'No Plex library contains these folders — check the path mapping';
      }
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
    }
    run.plex = result;
  }
  return run;
}

export interface MediaRefreshQueueDeps {
  getTargets(): MediaTargets;
  windowMs: () => number;
  /** Hard cap on how long a refresh can be held back by a steady trickle. */
  maxWaitMs?: () => number;
  runner?: typeof runRefresh;
  onRun?(run: RefreshRun): void;
}

export class MediaRefreshQueue {
  private dirs = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstAt = 0;
  private running: Promise<void> | null = null;

  constructor(private deps: MediaRefreshQueueDeps) {}

  get pending(): number { return this.dirs.size; }

  add(filePath: string): void {
    const t = this.deps.getTargets();
    if (!t.jellyfin && !t.plex) return;
    if (this.dirs.size === 0) this.firstAt = Date.now();
    this.dirs.add(refreshDirFor(filePath));
    const windowMs = this.deps.windowMs();
    const maxWait = this.deps.maxWaitMs?.() ?? windowMs * 4;
    const wait = Math.max(0, Math.min(windowMs, this.firstAt + maxWait - Date.now()));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, wait);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) await this.running;
    if (this.dirs.size === 0) return;
    const dirs = [...this.dirs];
    this.dirs.clear();
    const targets = this.deps.getTargets();
    this.running = (this.deps.runner ?? runRefresh)(dirs, targets)
      .then(run => this.deps.onRun?.(run))
      .catch(err => console.warn('[connect] media refresh failed:', err))
      .finally(() => { this.running = null; });
    await this.running;
  }
}
