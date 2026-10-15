/**
 * Tiny dependency-free fan-out bus for the "connect" layer (media-server
 * refresh + external notifications).
 *
 * The in-app notification feed (routes/notifications.ts) is derived from three
 * sources: pipeline_events rows, system_health rows and the staged-update
 * marker. Each of those has exactly one writer (`db.logPipelineEvent`,
 * `db.upsertHealthStatus`, update_watcher's staging step), and each writer
 * emits here once. Everything downstream (ntfy/Discord/... and Jellyfin/Plex
 * refresh) subscribes in one place (core/connect/index.ts) instead of being
 * sprinkled through the grabber / importer.
 *
 * Must stay import-free so db/index.ts can use it without cycles.
 */

export type ConnectSignal =
  | {
      source: 'pipeline';
      showId: string;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
      stage: string;
      eventType: string;
      message: string;
      reasonCode?: string | null;
      releaseTitle?: string | null;
      indexerName?: string | null;
      metadata?: any;
    }
  | {
      source: 'health';
      componentType: string;
      componentId: string;
      componentName: string;
      status: string;
      message?: string | null;
      reasonCode?: string | null;
    }
  | {
      source: 'update';
      tag: string;
      title?: string | null;
      releaseId: string;
    };

type Listener = (signal: ConnectSignal) => void;

const listeners = new Set<Listener>();

export function onConnectSignal(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Never throws: a broken subscriber must not break the db write it rides on. */
export function emitConnectSignal(signal: ConnectSignal): void {
  for (const fn of listeners) {
    try {
      fn(signal);
    } catch (err) {
      console.warn('[connect] listener failed:', err instanceof Error ? err.message : err);
    }
  }
}
