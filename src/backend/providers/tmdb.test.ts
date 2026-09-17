import { test, expect } from 'bun:test';
import { TMDBProvider } from './tmdb';

function stubFetch(capture: { url?: string; auth?: string | null }) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    capture.url = String(url);
    capture.auth = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
  return () => { globalThis.fetch = orig; };
}

test('v4 JWT token uses Bearer header, never ?api_key=', async () => {
  const capture: { url?: string; auth?: string | null } = {};
  const restore = stubFetch(capture);
  try {
    const p = new TMDBProvider({ apiKeys: { tmdb: 'eyJhbGc rocking-a-read-token' } });
    await p.searchShow(`Bearer probe ${Date.now()}`);
  } finally {
    restore();
  }
  expect(capture.url).not.toContain('api_key=');
  expect(capture.auth).toBe('Bearer eyJhbGc rocking-a-read-token');
});

test('v3 API key keeps using ?api_key= with no Authorization header', async () => {
  const capture: { url?: string; auth?: string | null } = {};
  const restore = stubFetch(capture);
  try {
    const p = new TMDBProvider({ apiKeys: { tmdb: 'abc123def456v3key' } });
    await p.searchShow(`V3 probe ${Date.now()}`);
  } finally {
    restore();
  }
  expect(capture.url).toContain('api_key=abc123def456v3key');
  expect(capture.auth).toBeNull();
});

/**
 * Bare numeric TMDB ids (no m- prefix) are ambiguous: films and series are
 * numbered in separate sequences, so /tv/<n> 404s when <n> is a movie. The
 * warmer and the /api/images/* routes pass whatever id a row carries, so a
 * 404 on the series path must retry as a film or those posters stay broken
 * forever.
 */
function stubTv404Movie(capture: { urls: string[] }, movieId: number) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    capture.urls.push(u);
    if (/\/tv\//.test(u)) {
      return new Response('nope', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify({ id: movieId, title: 'Thor', release_date: '2011-05-02', poster_path: '/p.jpg' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
  return () => { globalThis.fetch = orig; };
}

test('getShow falls back to /movie/ when a bare id is not a series', async () => {
  // Unique ids per run: provider responses are sqlite-cached by URL, and a
  // stale cache entry would short-circuit the fetch we're asserting on.
  const movieId = 9_000_000 + (Date.now() % 1_000_000);
  const capture: { urls: string[] } = { urls: [] };
  const restore = stubTv404Movie(capture, movieId);
  try {
    const p = new TMDBProvider({ apiKeys: { tmdb: 'abc123def456v3key' } });
    const show = await p.getShow(String(movieId));
    expect(show.id).toBe(`m-${movieId}`);
    expect(show.title).toBe('Thor');
    expect(capture.urls.some(u => u.includes(`/tv/${movieId}`))).toBe(true);
    expect(capture.urls.some(u => u.includes(`/movie/${movieId}`))).toBe(true);
  } finally {
    restore();
  }
});

test('getShow routes m- prefixed ids straight to /movie/ (no series probe)', async () => {
  const movieId = 9_500_000 + (Date.now() % 1_000_000);
  const capture: { urls: string[] } = { urls: [] };
  const restore = stubTv404Movie(capture, movieId);
  try {
    const p = new TMDBProvider({ apiKeys: { tmdb: 'abc123def456v3key' } });
    await p.getShow(`m-${movieId}`);
    expect(capture.urls.every(u => !u.includes('/tv/'))).toBe(true);
    expect(capture.urls.some(u => u.includes(`/movie/${movieId}`))).toBe(true);
  } finally {
    restore();
  }
});
