import type { ConnectSignal } from './bus';
import { sendToTarget, type FetchLike } from './notify_format';
import type { ConnectEventKind, ConnectMessage, NotificationTarget } from './types';

/**
 * Turns bus signals into external notifications.
 *
 * - classify: which in-app notification kinds map to which connect event.
 * - coalesce: events sharing a key (same event + same show) inside the window
 *   go out as one message, so a season pack import is one ping, not ten.
 * - fan out: every enabled target subscribed to that event gets it.
 */

export interface ClassifiedSignal {
  event: ConnectEventKind;
  /** Signals with the same key inside the window are merged. */
  key: string;
  severity: ConnectMessage['severity'];
  showId?: string;
  episodeCode?: string;
  line: string;
  data: Record<string, unknown>;
}

const epCode = (s?: number | null, e?: number | null) =>
  s != null && e != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : undefined;

/** Health state the notifier has already seen, per component — only transitions notify. */
export type HealthMemory = Map<string, string>;

const isBad = (status: string) => status === 'degraded' || status === 'down';

export function classifySignal(signal: ConnectSignal, health: HealthMemory): ClassifiedSignal | null {
  if (signal.source === 'pipeline') {
    const code = epCode(signal.seasonNumber, signal.episodeNumber);
    const data = {
      showId: signal.showId,
      season: signal.seasonNumber ?? null,
      episode: signal.episodeNumber ?? null,
      releaseTitle: signal.releaseTitle ?? null,
      indexer: signal.indexerName ?? null,
      reasonCode: signal.reasonCode ?? null,
      eventType: signal.eventType,
    };
    if (signal.eventType === 'grab_sent') {
      return { event: 'grabbed', key: `grabbed:${signal.showId}`, severity: 'info', showId: signal.showId, episodeCode: code, line: signal.releaseTitle || signal.message, data };
    }
    if (signal.eventType === 'import_completed') {
      return { event: 'imported', key: `imported:${signal.showId}`, severity: 'success', showId: signal.showId, episodeCode: code, line: signal.message, data };
    }
    const failed =
      signal.eventType === 'grab_failed' || signal.eventType === 'import_failed' || signal.eventType === 'download_failed'
      // "no indexers configured" is a setup problem surfaced via health, not a failed download.
      || (signal.stage === 'FAILED' && signal.eventType !== 'search_no_indexers');
    if (failed) {
      return { event: 'failed', key: `failed:${signal.showId}`, severity: 'error', showId: signal.showId, episodeCode: code, line: signal.message, data };
    }
    return null;
  }

  if (signal.source === 'health') {
    const id = `${signal.componentType}:${signal.componentId}`;
    const prev = health.get(id);
    health.set(id, signal.status);
    if (!isBad(signal.status) || prev === signal.status) return null;
    return {
      event: 'health',
      key: `health:${id}`,
      severity: signal.status === 'down' ? 'error' : 'warning',
      line: `${signal.componentName} is ${signal.status}${signal.message ? `: ${signal.message}` : ''}`,
      data: { component: id, componentName: signal.componentName, status: signal.status, reasonCode: signal.reasonCode ?? null },
    };
  }

  return {
    event: 'update',
    key: `update:${signal.tag}`,
    severity: 'info',
    line: `ShowFlow ${signal.title || signal.tag} is downloaded and ready to activate`,
    data: { tag: signal.tag, releaseId: signal.releaseId },
  };
}

const VERB: Record<ConnectEventKind, string> = {
  grabbed: 'grabbed',
  imported: 'imported',
  failed: 'failed',
  health: '',
  update: '',
};

/** Build the outgoing message for one coalesced batch (all same key). */
export function buildMessage(batch: ClassifiedSignal[], showTitle: string | null, now = new Date()): ConnectMessage {
  const first = batch[0]!;
  const ts = now.toISOString();
  if (first.event === 'health') {
    const last = batch[batch.length - 1]!;
    return { event: 'health', title: 'Health issue', body: last.line, severity: last.severity, timestamp: ts, data: last.data };
  }
  if (first.event === 'update') {
    return { event: 'update', title: 'Update available', body: first.line, severity: 'info', timestamp: ts, data: first.data };
  }
  const who = showTitle || 'ShowFlow';
  if (batch.length === 1) {
    const title = [who, first.episodeCode, VERB[first.event]].filter(Boolean).join(' ');
    return { event: first.event, title, body: first.line, severity: first.severity, timestamp: ts, data: first.data };
  }
  const codes = batch.map(b => b.episodeCode).filter(Boolean) as string[];
  const unique = [...new Set(codes)];
  const noun = unique.length === batch.length ? 'episodes' : 'items';
  const shown = batch.slice(0, 8).map(b => `• ${b.episodeCode ? `${b.episodeCode} ` : ''}${b.line}`);
  if (batch.length > 8) shown.push(`…and ${batch.length - 8} more`);
  return {
    event: first.event,
    title: `${who}: ${batch.length} ${noun} ${VERB[first.event]}`,
    body: shown.join('\n'),
    severity: batch.some(b => b.severity === 'error') ? 'error' : first.severity,
    timestamp: ts,
    data: { ...first.data, count: batch.length, episodes: unique, items: batch.map(b => b.data) },
  };
}

export function targetsFor(targets: NotificationTarget[], event: ConnectEventKind): NotificationTarget[] {
  return targets.filter(t => t.enabled && t.events[event]);
}

export interface NotifierDeps {
  getTargets(): NotificationTarget[];
  showTitle?(showId: string): string | null;
  fetchImpl?: FetchLike;
  /** Coalesce window in ms (default 10s). */
  windowMs?: number;
  log?(msg: string): void;
}

export class Notifier {
  private buffers = new Map<string, { items: ClassifiedSignal[]; timer: ReturnType<typeof setTimeout> }>();
  readonly health: HealthMemory = new Map();
  private inflight = new Set<Promise<unknown>>();

  constructor(private deps: NotifierDeps) {}

  /** Prime health memory so a restart doesn't re-announce standing issues. */
  seedHealth(rows: { componentType: string; componentId: string; status: string }[]) {
    for (const r of rows) this.health.set(`${r.componentType}:${r.componentId}`, r.status);
  }

  handle(signal: ConnectSignal): void {
    const c = classifySignal(signal, this.health);
    if (!c) return;
    // Cheap early-out: nobody listening for this event -> don't buffer.
    if (targetsFor(this.deps.getTargets(), c.event).length === 0) return;
    const existing = this.buffers.get(c.key);
    if (existing) {
      existing.items.push(c);
      return;
    }
    const timer = setTimeout(() => this.flushKey(c.key), this.deps.windowMs ?? 10_000);
    this.buffers.set(c.key, { items: [c], timer });
  }

  /** Send everything buffered now (tests + shutdown). */
  async flushAll(): Promise<void> {
    for (const key of [...this.buffers.keys()]) this.flushKey(key);
    await Promise.all([...this.inflight]);
  }

  private flushKey(key: string) {
    const buf = this.buffers.get(key);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.buffers.delete(key);
    const first = buf.items[0]!;
    let title: string | null = null;
    if (first.showId && this.deps.showTitle) {
      try { title = this.deps.showTitle(first.showId); } catch { title = null; }
    }
    const msg = buildMessage(buf.items, title);
    for (const target of targetsFor(this.deps.getTargets(), msg.event)) {
      const p = sendToTarget(target, msg, this.deps.fetchImpl).then(r => {
        if (!r.ok) this.deps.log?.(`[connect] ${target.type} "${target.name}" failed: ${r.error}`);
      });
      this.inflight.add(p);
      p.finally(() => this.inflight.delete(p));
    }
  }
}

/** The fixed sample sent by the Test button. */
export function testMessage(): ConnectMessage {
  return {
    event: 'imported',
    title: 'ShowFlow test notification',
    body: 'If you can read this, ShowFlow can reach this target.',
    severity: 'info',
    timestamp: new Date().toISOString(),
    data: { test: true },
  };
}
