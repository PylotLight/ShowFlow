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
