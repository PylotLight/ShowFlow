import { describe, expect, test } from 'bun:test';
import { formatRequest, sendToTarget } from './notify_format';
import { Notifier, buildMessage, classifySignal, targetsFor } from './notifier';
import { MediaRefreshQueue, mapPath, pickPlexSection, refreshDirFor, runRefresh } from './media_refresh';
import { maskSettings, mergeIncomingTarget, mergeIncomingMediaRefresh, parseConnectSettings } from './settings';
import { NotificationTargetSchema, SECRET_MASK, type ConnectMessage, type NotificationTarget } from './types';
import type { ConnectSignal } from './bus';

const msg: ConnectMessage = {
  event: 'imported', title: 'Severance S02E03 imported', body: 'Imported "x.mkv" for Severance',
  severity: 'success', timestamp: '2026-10-15T00:00:00.000Z', data: { showId: 's1' },
};
const allOn = { grabbed: true, imported: true, failed: true, health: true, update: true };
const T = (t: Record<string, any>): NotificationTarget => NotificationTargetSchema.parse({ id: 'x', name: 'n', ...t });

describe('payload formatting', () => {
  test('ntfy: JSON publish to server root, bearer token, priority', () => {
    const r = formatRequest(T({ type: 'ntfy', url: 'https://ntfy.sh/', topic: 'showflow', token: 'tk_abc' }), msg);
    expect(r.url).toBe('https://ntfy.sh');
    expect(r.init.headers.Authorization).toBe('Bearer tk_abc');
    const b = JSON.parse(r.init.body);
    expect(b).toEqual({ topic: 'showflow', title: msg.title, message: msg.body, tags: ['tv'], priority: 3 });
    const err = JSON.parse(formatRequest(T({ type: 'ntfy', url: 'https://n', topic: 't' }), { ...msg, event: 'failed', severity: 'error' }).init.body);
    expect(err.priority).toBe(4);
    expect(err.tags).toEqual(['warning']);
  });

  test('ntfy: user:pass becomes basic auth, no token = no header', () => {
    const r = formatRequest(T({ type: 'ntfy', url: 'https://n', topic: 't', token: 'me:pw' }), msg);
    expect(r.init.headers.Authorization).toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`);
    expect(formatRequest(T({ type: 'ntfy', url: 'https://n', topic: 't' }), msg).init.headers.Authorization).toBeUndefined();
  });

  test('discord: embed with color, footer label, clipped title', () => {
    const r = formatRequest(T({ type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/abc' }), { ...msg, title: 'x'.repeat(400) });
    expect(r.url).toBe('https://discord.com/api/webhooks/1/abc');
    const b = JSON.parse(r.init.body);
    expect(b.username).toBe('ShowFlow');
    expect(b.embeds[0].title.length).toBe(256);
    expect(b.embeds[0].color).toBe(0x22c55e);
    expect(b.embeds[0].footer.text).toBe('Imported / upgraded');
    expect(b.embeds[0].timestamp).toBe(msg.timestamp);
  });

  test('apprise: maps severity to apprise type, optional tag', () => {
    const r = formatRequest(T({ type: 'apprise', url: 'http://apprise:8000/notify/sf', tags: 'tv' }), { ...msg, severity: 'error' });
    expect(JSON.parse(r.init.body)).toEqual({ title: msg.title, body: msg.body, type: 'failure', format: 'text', tag: 'tv' });
    const noTag = JSON.parse(formatRequest(T({ type: 'apprise', url: 'http://a/notify' }), msg).init.body);
    expect(noTag.tag).toBeUndefined();
    expect(noTag.type).toBe('success');
  });

  test('webhook: generic JSON with event + data, optional auth header', () => {
    const r = formatRequest(T({ type: 'webhook', url: 'https://hook', authHeader: 'Bearer z' }), msg);
    expect(r.init.headers.Authorization).toBe('Bearer z');
    expect(JSON.parse(r.init.body)).toEqual({
      app: 'showflow', event: 'imported', title: msg.title, message: msg.body,
      severity: 'success', timestamp: msg.timestamp, data: { showId: 's1' },
    });
  });

  test('sendToTarget reports HTTP errors and network errors (mock fetch)', async () => {
    const t = T({ type: 'webhook', url: 'https://hook' });
    const calls: any[] = [];
    const ok = await sendToTarget(t, msg, async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204, text: async () => '' }; });
    expect(ok).toEqual({ ok: true });
    expect(calls[0].url).toBe('https://hook');
    expect(calls[0].init.method).toBe('POST');
    const bad = await sendToTarget(t, msg, async () => ({ ok: false, status: 403, text: async () => 'nope' }));
    expect(bad).toEqual({ ok: false, error: 'HTTP 403: nope' });
    const boom = await sendToTarget(t, msg, async () => { throw new Error('ECONNREFUSED'); });
    expect(boom).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

const pipe = (p: Partial<Extract<ConnectSignal, { source: 'pipeline' }>>): ConnectSignal =>
  ({ source: 'pipeline', showId: 's1', stage: 'GRABBED', eventType: 'x', message: 'm', ...p }) as ConnectSignal;

describe('event classification + filtering', () => {
  test('pipeline events map to grabbed / imported / failed; noise ignored', () => {
    const h = new Map();
    expect(classifySignal(pipe({ eventType: 'grab_sent', releaseTitle: 'Rel' }), h)?.event).toBe('grabbed');
    expect(classifySignal(pipe({ stage: 'AVAILABLE', eventType: 'import_completed', seasonNumber: 1, episodeNumber: 2 }), h))
      .toMatchObject({ event: 'imported', episodeCode: 'S01E02' });
    expect(classifySignal(pipe({ stage: 'FAILED', eventType: 'import_failed' }), h)?.event).toBe('failed');
    expect(classifySignal(pipe({ stage: 'FAILED', eventType: 'grab_failed' }), h)?.event).toBe('failed');
    // core/release_failures.ts: TorBox gave up -> grab failed + blocklisted.
    expect(classifySignal(pipe({ stage: 'FAILED', eventType: 'download_failed', reasonCode: 'RELEASE_FAILED_BLOCKLISTED' }), h)?.event).toBe('failed');
    expect(classifySignal(pipe({ stage: 'FAILED', eventType: 'search_no_indexers' }), h)).toBeNull();
    expect(classifySignal(pipe({ stage: 'SEARCHING', eventType: 'search_completed' }), h)).toBeNull();
    expect(classifySignal(pipe({ stage: 'SEARCHING', eventType: 'no_qualifying_releases' }), h)).toBeNull();
  });

  test('health only notifies on transition into degraded/down', () => {
    const h = new Map();
    const hs = (status: string): ConnectSignal => ({ source: 'health', componentType: 'indexer', componentId: '1', componentName: 'Nyaa', status });
    expect(classifySignal(hs('healthy'), h)).toBeNull();
    expect(classifySignal(hs('down'), h)).toMatchObject({ event: 'health', severity: 'error' });
    expect(classifySignal(hs('down'), h)).toBeNull(); // still down: no repeat every poll
    expect(classifySignal(hs('degraded'), h)?.severity).toBe('warning');
    expect(classifySignal(hs('healthy'), h)).toBeNull();
    expect(classifySignal(hs('down'), h)).not.toBeNull();
  });

  test('update signal', () => {
    expect(classifySignal({ source: 'update', tag: 'v0.2.0', releaseId: 'r' }, new Map())?.event).toBe('update');
  });

  test('targetsFor honours enabled + per-event toggles', () => {
    const a = T({ id: 'a', type: 'webhook', url: 'https://a', events: { ...allOn, grabbed: false } });
    const b = T({ id: 'b', type: 'webhook', url: 'https://b', enabled: false });
    const c = T({ id: 'c', type: 'webhook', url: 'https://c' });
    expect(targetsFor([a, b, c], 'grabbed').map(t => t.id)).toEqual(['c']);
    expect(targetsFor([a, b, c], 'imported').map(t => t.id)).toEqual(['a', 'c']);
  });
});

describe('notifier coalescing', () => {
  test('season pack imports within the window go out as one message per target', async () => {
    const sent: { url: string; body: any }[] = [];
    const targets = [
      T({ id: 'a', type: 'webhook', url: 'https://a' }),
      T({ id: 'b', type: 'webhook', url: 'https://b', events: { ...allOn, imported: false } }),
    ];
    const n = new Notifier({
      getTargets: () => targets,
      showTitle: () => 'Severance',
      windowMs: 30,
      fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '' }; },
    });
    for (let e = 1; e <= 10; e++) n.handle(pipe({ stage: 'AVAILABLE', eventType: 'import_completed', seasonNumber: 2, episodeNumber: e, message: `ep ${e}` }));
    n.handle(pipe({ showId: 's2', eventType: 'grab_sent', releaseTitle: 'Other.S01E01' }));
    expect(sent).toHaveLength(0);
    await Bun.sleep(80);
    await n.flushAll();
    const imported = sent.filter(s => s.body.event === 'imported');
    expect(imported).toHaveLength(1);
    expect(imported[0]!.url).toBe('https://a');
    expect(imported[0]!.body.title).toBe('Severance: 10 episodes imported');
    expect(imported[0]!.body.data.count).toBe(10);
    // grab for another show: both targets subscribed
    expect(sent.filter(s => s.body.event === 'grabbed').map(s => s.url).sort()).toEqual(['https://a', 'https://b']);
  });

  test('nothing buffered when no target wants the event', async () => {
    let calls = 0;
    const n = new Notifier({
      getTargets: () => [T({ type: 'webhook', url: 'https://a', events: { ...allOn, failed: false } })],
      windowMs: 5,
      fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => '' }; },
    });
    n.handle(pipe({ stage: 'FAILED', eventType: 'import_failed' }));
    await n.flushAll();
    expect(calls).toBe(0);
  });

  test('single-item message names show + episode', () => {
    const c = classifySignal(pipe({ eventType: 'grab_sent', seasonNumber: 1, episodeNumber: 5, releaseTitle: 'Show.S01E05.1080p' }), new Map())!;
    const m = buildMessage([c], 'Show');
    expect(m.title).toBe('Show S01E05 grabbed');
    expect(m.body).toBe('Show.S01E05.1080p');
  });
});

describe('media refresh path selection', () => {
  test('mapPath swaps prefix only on a path boundary', () => {
    const map = { from: '/data/tv', to: '/media/tv' };
    expect(mapPath('/data/tv/Show/Season 01', map)).toBe('/media/tv/Show/Season 01');
    expect(mapPath('/data/tvshows/x', map)).toBe('/data/tvshows/x');
    expect(mapPath('/data/tv/x', { from: '', to: '/y' })).toBe('/data/tv/x');
    expect(mapPath('/data/tv/x', { from: '/data/tv/', to: '/m/' })).toBe('/m/x');
  });

  test('refreshDirFor = parent folder', () => {
    expect(refreshDirFor('/tv/Show/Season 01/Show S01E01.mkv')).toBe('/tv/Show/Season 01');
  });

  test('pickPlexSection takes the longest containing location', () => {
    const sections = [
      { key: '1', title: 'Media', type: 'show', locations: ['/media'] },
      { key: '2', title: 'TV', type: 'show', locations: ['/media/tv', '/mnt/tv2'] },
      { key: '3', title: 'TV Kids', type: 'show', locations: ['/media/tvkids'] },
    ];
    expect(pickPlexSection(sections, '/media/tv/Show/Season 01')?.key).toBe('2');
    expect(pickPlexSection(sections, '/media/tvkids/Bluey')?.key).toBe('3');
    expect(pickPlexSection(sections, '/mnt/tv2/X')?.key).toBe('2');
    expect(pickPlexSection(sections, '/media/movies/X')?.key).toBe('1');
    expect(pickPlexSection(sections, '/elsewhere/X')).toBeNull();
  });

  test('runRefresh: jellyfin targeted with mapped dirs, plex per-section with path', async () => {
    const jf: string[][] = [];
    const px: [string, string | undefined][] = [];
    const run = await runRefresh(['/data/tv/A/Season 01', '/data/tv/A/Season 01', '/data/x/B'], {
      jellyfin: { client: { notifyMediaUpdated: async p => { jf.push(p); }, refreshLibrary: async () => { throw new Error('no'); } }, pathMap: { from: '/data', to: '/jf' } },
      plex: {
        client: { getSections: async () => [{ key: '7', title: 'TV', type: 'show', locations: ['/plex/tv'] }], refreshSection: async (k, p) => { px.push([k, p]); } },
        pathMap: { from: '/data', to: '/plex' },
      },
    });
    expect(jf).toEqual([['/jf/tv/A/Season 01', '/jf/x/B']]);
    expect(run.jellyfin).toEqual({ mode: 'targeted', ok: true });
    expect(px).toEqual([['7', '/plex/tv/A/Season 01']]);
    expect(run.plex?.unmatched).toEqual(['/plex/x/B']);
    expect(run.plex?.ok).toBe(true);
  });

  test('runRefresh: jellyfin falls back to full library refresh', async () => {
    let full = 0;
    const run = await runRefresh(['/a'], {
      jellyfin: { client: { notifyMediaUpdated: async () => { throw new Error('403'); }, refreshLibrary: async () => { full++; } } },
    });
    expect(full).toBe(1);
    expect(run.jellyfin?.mode).toBe('full');
    expect(run.jellyfin?.ok).toBe(true);
  });
});

describe('media refresh debounce', () => {
  const fakeTargets = { jellyfin: { client: { notifyMediaUpdated: async () => {}, refreshLibrary: async () => {} } } };

  test('ten files in one season folder -> one refresh with one folder', async () => {
    const runs: string[][] = [];
    const q = new MediaRefreshQueue({
      getTargets: () => fakeTargets,
      windowMs: () => 40,
      runner: async (dirs) => { runs.push(dirs); return { at: '', dirs }; },
    });
    for (let i = 1; i <= 10; i++) q.add(`/tv/Show/Season 01/Show S01E${String(i).padStart(2, '0')}.mkv`);
    await Bun.sleep(10);
    expect(runs).toHaveLength(0);
    await Bun.sleep(80);
    expect(runs).toEqual([['/tv/Show/Season 01']]);
  });

  test('trailing debounce resets on new files but max wait caps the delay', async () => {
    const runs: number[] = [];
    const start = Date.now();
    const q = new MediaRefreshQueue({
      getTargets: () => fakeTargets,
      windowMs: () => 40,
      maxWaitMs: () => 100,
      runner: async (dirs) => { runs.push(Date.now() - start); return { at: '', dirs }; },
    });
    // trickle a file every 20ms for ~200ms — window never goes quiet
    for (let i = 0; i < 10; i++) { q.add(`/tv/S/Season 01/e${i}.mkv`); await Bun.sleep(20); }
    await Bun.sleep(60);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]!).toBeLessThan(160);
  });

  test('no-op when no media server is enabled', async () => {
    const q = new MediaRefreshQueue({ getTargets: () => ({}), windowMs: () => 5 });
    q.add('/tv/x.mkv');
    expect(q.pending).toBe(0);
  });
});

describe('settings secrets', () => {
  test('mask on read, keep stored secret when mask comes back', () => {
    const stored = T({ id: 'd', type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/secret' });
    const s = parseConnectSettings({ targets: [stored], mediaRefresh: { plex: { enabled: true, baseUrl: 'http://plex:32400', token: 'tok' } } });
    const masked = maskSettings(s);
    expect((masked.targets[0] as any).webhookUrl).toBe(SECRET_MASK);
    expect(masked.mediaRefresh.plex.token).toBe(SECRET_MASK);
    const back = mergeIncomingTarget({ ...masked.targets[0], name: 'renamed' }, stored);
    expect(back.ok && (back.target as any).webhookUrl).toBe('https://discord.com/api/webhooks/1/secret');
    const mr = mergeIncomingMediaRefresh({ plex: { token: SECRET_MASK, enabled: false } }, s.mediaRefresh);
    expect(mr.ok && mr.value.plex.token).toBe('tok');
    expect(mr.ok && mr.value.plex.enabled).toBe(false);
  });

  test('validation errors are readable; broken stored targets are dropped, not fatal', () => {
    const r = mergeIncomingTarget({ id: 'n', name: 'x', type: 'ntfy', url: 'ntfy.sh', topic: 'a b' }, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('http(s) URL');
    const s = parseConnectSettings(JSON.stringify({ targets: [{ id: 'bad', type: 'ntfy' }, { id: 'ok', name: 'w', type: 'webhook', url: 'https://w' }] }));
    expect(s.targets.map(t => t.id)).toEqual(['ok']);
  });
});

describe('central hook', () => {
  test('db.logPipelineEvent + upsertHealthStatus emit on the connect bus', async () => {
    const { DatabaseManager } = await import('../../db/index');
    const { onConnectSignal } = await import('./bus');
    const db = new DatabaseManager(':memory:');
    db.saveShow({ uuid: 'hk', providerId: 'p1', type: 'tmdb', title: 'Hook Show', config: {} } as any);
    const seen: ConnectSignal[] = [];
    const off = onConnectSignal(s => seen.push(s));
    try {
      db.logPipelineEvent({ showId: 'hk', seasonNumber: 1, episodeNumber: 1, stage: 'AVAILABLE', eventType: 'import_completed', message: 'Imported', metadata: { filePath: '/tv/a.mkv' } });
      db.upsertHealthStatus({ componentType: 'indexer', componentId: 'n', componentName: 'Nyaa', status: 'down' } as any);
    } finally { off(); }
    expect(seen.map(s => s.source)).toEqual(['pipeline', 'health']);
    expect((seen[0] as any).metadata.filePath).toBe('/tv/a.mkv');
  });
});
