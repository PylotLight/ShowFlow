import { test, expect } from "bun:test";
import { db } from "../db";
import { SyncManager } from "../core/sync_manager";
import { imageRoutes } from "./images";

/**
 * Movie artwork must warm from the metadata sync already performed, not only
 * lazily when the grid's <img> 404s. Previously a movie sync logged
 * "Successfully synced movie" but persisted no bytes, so a fresh bulk-add of
 * films showed the "no signal" placeholder indefinitely. This test drives the
 * real sync + poster route with a stubbed network and a unique TMDB id (so the
 * provider sqlite response-cache from other specs can't short-circuit the
 * calls we assert on).
 */
const RUN = `aw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const MID = 7_000_000 + (Date.now() % 900_000);
const posterRoute = (imageRoutes() as any)["/api/shows/:id/images/poster"].GET;
const TMDB_API = "api.themoviedb.org";

function stubTmdb() {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const s = String(url);
    calls.push(s);
    if (s.includes(`/movie/${MID}`)) {
      return new Response(JSON.stringify({
        id: MID, title: "Thor", release_date: "2011-05-02",
        poster_path: "/poster.jpg", backdrop_path: "/back.jpg", media_kind: "movie",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (s.includes("image.tmdb.org")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("movie sync warms poster bytes and the poster route serves them", async () => {
  db.setSetting("apiKeys", { tmdb: "abc123def456v3key" });
  const uuid = `${RUN}-thor`;
  db.saveShow({
    uuid, providerId: `m-${MID}`, type: "tmdb", title: "Thor", year: 2011,
    config: {}, seriesType: "movie", rootFolderPath: `/tmp/${RUN}`,
  });
  const { calls, restore } = stubTmdb();
  const req = (size?: string) => ({ url: `http://x/api/shows/${uuid}/images/poster${size ? `?size=${size}` : ""}`, params: { id: uuid } });
  try {
    await new SyncManager({ apiKeys: { tmdb: "abc123def456v3key" } } as any).syncShow(uuid);
    // The warm is fire-and-forget; poll briefly for the bytes to land.
    for (let i = 0; i < 60 && db.getShowArtworks(uuid, 2).length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const art = db.getShowArtworks(uuid, 2);
    expect(art.length).toBe(1);
    // Stored as the lightweight card variant the grid actually requests.
    expect(art[0].image_url).toInclude("w342");

    expect((await posterRoute(req("card"))).status).toBe(200);
    expect((await posterRoute(req())).status).toBe(200);

    // Warm reused the synced metadata's poster path — exactly one TMDB API
    // call (the sync itself), no extra provider hit, no flood.
    const apiCalls = calls.filter(c => c.includes(TMDB_API)).length;
    expect(apiCalls).toBe(1);
  } finally {
    restore();
    try { db.removeShow(uuid); } catch {}
  }
}, 15_000);
