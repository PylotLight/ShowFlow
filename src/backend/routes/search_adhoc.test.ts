import { test, expect } from 'bun:test';
import { searchRoutes } from './search';

const adhoc = (searchRoutes(null as any) as Record<string, any>)['/api/search/adhoc'];

function get(url: string) {
  return adhoc.GET({ url } as any);
}

test('adhoc search requires a query and returns the envelope shape', async () => {
  for (const url of [
    'http://localhost/api/search/adhoc',
    'http://localhost/api/search/adhoc?q=',
    'http://localhost/api/search/adhoc?q=%20%20',
  ]) {
    const res = await get(url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ results: [], indexers: [], total: 0 });
  }
});

test('adhoc search accepts picker, category, type and limit params', async () => {
  // No indexers are stubbed here — this asserts the params are accepted and
  // the per-indexer stats envelope is well-formed, not specific results.
  // (With no indexers reachable it returns zero results without throwing.)
  const res = await get(
    'http://localhost/api/search/adhoc?q=test&type=tvsearch&limit=25&category=5000&category=5070&indexer=1&native=nyaa',
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.results)).toBe(true);
  expect(Array.isArray(body.indexers)).toBe(true);
  expect(typeof body.total).toBe('number');
  for (const s of body.indexers) {
    expect(typeof s.key).toBe('string');
    expect(typeof s.name).toBe('string');
    expect(typeof s.ok).toBe('boolean');
    expect(typeof s.ms).toBe('number');
    expect(typeof s.count).toBe('number');
  }
});
