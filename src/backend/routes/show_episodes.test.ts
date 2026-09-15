import { test, expect } from 'bun:test';
import { showRoutes } from './shows';

const routes = showRoutes(null as any, null as any) as Record<string, any>;

test('GET /api/shows/:id/episodes returns empty seasons for an unknown show', async () => {
  const handler = routes['/api/shows/:id/episodes'];
  expect(handler).toBeDefined();
  const res = await handler.GET({ params: { id: 'show-that-does-not-exist' }, url: 'http://localhost/api/shows/x/episodes' } as any);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ seasons: [] });
});
