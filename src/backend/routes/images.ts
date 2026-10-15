import { db } from "../db";
import { ProviderFactory } from "../providers/factory";
import { TVDBProvider } from "../providers/tvdb";
import { TMDBProvider } from "../providers/tmdb";
import type { ProviderType } from "../providers/factory";
import { json, errorResponse, loadConfig, isProviderType, extractPosterUrl, extractBackdropUrl, toCardPosterUrl, NO_SIGNAL_SVG } from "./_shared";
import { warmPoster } from "./artwork_warmer";
import type { ShowArtworkMeta } from "../db/shows";
import { absImagePath } from "../core/image_store";
import { existsSync } from "node:fs";

export interface BackdropOption {
  index: number;
  url: string;
  width?: number;
  height?: number;
  /** Small fast variant for blur-up placeholders (TMDB w300, TVDB thumbnail). */
  thumb?: string;
}

/** De-duplicate provider artwork lists by URL, assigning stable indexes. */
export function dedupeBackdropOptions(items: { url?: string | null; width?: number; height?: number; thumb?: string | null }[]): BackdropOption[] {
  const seen = new Set<string>();
  const out: BackdropOption[] = [];
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({ index: out.length, url: item.url, width: item.width, height: item.height, thumb: item.thumb ?? undefined });
  }
  return out;
}

/** Clamp a stored/selected index against the live option list. */
export function clampBackdropIndex(options: { url: string }[], stored: number): number {
  if (options.length === 0) return 0;
  if (!Number.isFinite(stored) || stored < 0) return 0;
  return Math.min(Math.floor(stored), options.length - 1);
}

/**
 * Serve one cached show_artworks row with an ETag, answering 304 from the
 * metadata alone when the browser already has it.
 *
 * Rows moved to disk (core/image_store.ts) are served straight from their
 * content-addressed file with ETag = the sha1. When the request carries
 * ?v=<that same hash> the URL itself is content-keyed, so it's cached for a
 * year as immutable. Without it (or with a stale v) the route URL can
 * change what it returns (?index, re-warms), so it keeps the normal
 * max-age and the ETag makes revalidation nearly free.
 *
 * Legacy rows still holding a blob (background migration not there yet)
 * and rows whose file went missing fall back to the DB bytes.
 */
function serveArtworkRow(req: Request, row: ShowArtworkMeta, maxAge: number): Response {
  const version = new URL(req.url).searchParams.get("v");
  const etag = row.image_hash
    ? `"${row.image_hash}"`
    : `W/"a${row.id}-${Bun.hash(`${row.image_url}|${row.data_len}`).toString(36)}"`;
  const immutable = !!row.image_hash && version === row.image_hash;
  const headers = {
    "Content-Type": row.content_type ?? "image/jpeg",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : `public, max-age=${maxAge}`,
    ETag: etag,
  };
  if (row.image_path) {
    const abs = absImagePath(db.imagesDir, row.image_path);
    if (abs && existsSync(abs)) {
      const inm = req.headers?.get("if-none-match");
      if (inm && inm.split(",").some((t) => { const v = t.trim(); return v === etag || v === `W/${etag}` || v === "*"; })) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(Bun.file(abs), { headers });
    }
    // File gone (volume wiped / manual cleanup): forget it so the row reads
    // as uncached and gets re-warmed, then try the legacy blob below.
    db.clearShowArtworkImage(row.id);
    const legacy = db.getShowArtworkBlob(row.id);
    if (!legacy || legacy.byteLength === 0) return new Response("", { status: 404 });
    return new Response(legacy as unknown as BodyInit, {
      headers: { "Content-Type": row.content_type ?? "image/jpeg", "Cache-Control": `public, max-age=${maxAge}` },
    });
  }
  const inm = req.headers?.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
    return new Response(null, { status: 304, headers });
  }
  const data = db.getShowArtworkBlob(row.id);
  if (!data) return new Response("", { status: 404 });
  return new Response(data as unknown as BodyInit, { headers });
}

function isBackdropRow(a: any): boolean {
  return (a.artwork_type === "3" || a.artwork_type === "15" || a.artwork_type === "fanart" || a.artwork_type === "background");
}

/**
 * Every backdrop the provider knows about for a show (TVDB fanart types
 * 3+15, TMDB voted backdrops), falling back to the single metadata
 * backdrop when the provider exposes no list. No image bytes are fetched
 * here — the detail route fetches on selection.
 */
async function listBackdropOptions(show: any, config: any): Promise<{ url: string; width?: number; height?: number; thumb?: string }[]> {
  try {
    if (show.provider_type === "tvdb") {
      const tvdb = ProviderFactory.getProvider("tvdb", config) as TVDBProvider;
      const out: { url: string; width?: number; height?: number; thumb?: string }[] = [];
      for (const at of [3, 15]) {
        const arts = await tvdb.getSeriesArtworks(show.provider_id, at);
        for (const a of arts) {
          if (a?.image) out.push({
            url: a.image,
            width: a.width ?? undefined,
            height: a.height ?? undefined,
            thumb: typeof a.thumbnail === 'string' && a.thumbnail.length > 0 ? a.thumbnail : undefined,
          });
        }
      }
      if (out.length > 0) return out;
    } else if (show.provider_type === "tmdb") {
      const tmdb = ProviderFactory.getProvider("tmdb", config) as TMDBProvider;
      const backs = await tmdb.getBackdrops(show.provider_id);
      if (backs.length > 0) return backs.map((b) => ({
        ...b,
        // w1280 → w300: same CDN path, ~20KB instead of ~500KB.
        thumb: b.url.includes('/t/p/w1280') ? b.url.replace('/t/p/w1280', '/t/p/w300') : undefined,
      }));
    }
  } catch {
    // Fall through to the single-backdrop fallback below.
  }
  try {
    const provider = ProviderFactory.getProvider(show.provider_type, config);
    const showData = await provider.getShow(show.provider_id);
    const url = extractBackdropUrl(show.provider_type, showData.metadata);
    return url ? [{ url }] : [];
  } catch {
    return [];
  }
}

export function imageRoutes() {
  return {

    "/api/shows/:id/images/poster": {
      // DB-only serving (issues #31): this route NEVER touches the network.
      // On a cache miss it enqueues a background warm (artwork_warmer.ts)
      // and returns 404 + placeholder immediately — the UI retries and the
      // bytes are here on the next pass. Blocking hundreds of card requests
      // behind live TVDB/TMDB fetches was the library-grid stall.
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return new Response(NO_SIGNAL_SVG, { status: 404, headers: { "Content-Type": "image/svg+xml" } });

          const params = new URL(req.url).searchParams;
          const wantCard = params.get("size") === "card";
          const cached = db.getShowArtworkMeta(show.id, 2);

          const miss = () => {
            warmPoster(show.id);
            return new Response(NO_SIGNAL_SVG, { status: 404, headers: { "Content-Type": "image/svg+xml" } });
          };

          if (cached.length === 0) return miss();

          // Full remote URL is known without any provider call when a cached
          // row recorded it — the common warm case.
          const fullUrl: string | null = cached.find(a => a.image_url)?.image_url ?? null;
          if (!fullUrl) {
            // Legacy row without a recorded URL: serve what we have and warm
            // in the background to backfill proper URL-keyed rows.
            const legacy = cached.find(a => a.data_len > 0);
            warmPoster(show.id);
            if (legacy) return serveArtworkRow(req, legacy, 3600);
            return miss();
          }

          const targetUrl = wantCard ? (toCardPosterUrl(show.provider_type, fullUrl) ?? fullUrl) : fullUrl;
          const direct = cached.find(a => a.data_len > 0 && a.image_url === targetUrl);
          if (direct) {
            return serveArtworkRow(req, direct, 86400);
          }

          // Wrong size cached (e.g. full bytes, card requested): serve it
          // instantly anyway and warm the missing variant alongside.
          const fallback = cached.find(a => a.data_len > 0);
          warmPoster(show.id);
          if (fallback) return serveArtworkRow(req, fallback, 3600);
          return miss();
        } catch (err) {
          console.warn(`[api] poster fetch failed for show ${req.params.id!}:`, err);
          return new Response(NO_SIGNAL_SVG, { status: 404, headers: { "Content-Type": "image/svg+xml" } });
        }
      },
    },

    "/api/shows/:id/images/backdrop": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return new Response('', { status: 404 });

          const cached = db.getShowArtworkMeta(show.id);
          const config = loadConfig();
          const params = new URL(req.url).searchParams;
          const requestedParam = params.get("index");
          const requested = requestedParam != null ? parseInt(requestedParam, 10) : NaN;
          const wantThumb = params.get("thumb") === "1";

          // When the provider exposes multiple backdrops, serve the
          // requested (or stored) selection. The cached-bytes fast path
          // only applies when the cached row is this exact URL — otherwise
          // a stale pick would stick after cycling.
          //
          // Fast path first: the persisted option list resolves an index to
          // a URL with zero network calls, so the common case (cached bytes
          // for the selected backdrop) never waits on the provider. The
          // provider is only hit on a cold cache, and its result is then
          // persisted for next time.
          let options = db.getShowBackdropOptions(show.id);
          if (options.length === 0) {
            options = dedupeBackdropOptions(await listBackdropOptions(show, config));
            if (options.length > 0) db.saveShowBackdropOptions(show.id, options);
          }
          if (options.length > 0) {
            const stored = db.getShowBackdropIndex(show.id);
            const idx = clampBackdropIndex(options, Number.isFinite(requested) ? requested : stored);
            const picked = options[idx]!;

            // Blur-up path (?thumb=1): serve the tiny variant instantly from
            // local bytes. On a cold cache the thumb itself is fetched (small
            // and fast) while the full image is primed in the background, so
            // the follow-up full request usually hits cached bytes.
            // Thumb bytes live in art_type "115" rows keyed by thumb URL —
            // no schema change, one row per show.
            const thumbUrl = picked.thumb || (picked.url.includes('/t/p/w1280') ? picked.url.replace('/t/p/w1280', '/t/p/w300') : undefined);
            if (wantThumb && thumbUrl) {
              const thumbRow = cached.find(a => a.artwork_type === "115" && a.data_len > 0 && a.image_url === thumbUrl);
              if (thumbRow) return serveArtworkRow(req, thumbRow, 86400);
              try {
                const thumbRes = await fetch(thumbUrl);
                if (thumbRes.ok) {
                  const thumbType = thumbRes.headers.get("Content-Type") ?? "image/jpeg";
                  const thumbBytes = new Uint8Array(await thumbRes.arrayBuffer());
                  db.saveShowArtwork(show.id, 115, thumbUrl, undefined, undefined, undefined, thumbBytes, thumbType);
                  // Prime the full image now so it's cached when asked for.
                  fetch(picked.url).then(async (r) => {
                    if (!r.ok) return;
                    const ct = r.headers.get("Content-Type") ?? "image/jpeg";
                    const bytes = new Uint8Array(await r.arrayBuffer());
                    db.saveShowArtwork(show.id, 15, picked.url, picked.width, picked.height, undefined, bytes, ct);
                  }).catch(() => {});
                  return new Response(thumbBytes, {
                    headers: { "Content-Type": thumbType, "Cache-Control": "public, max-age=86400" },
                  });
                }
              } catch {
                // Fall through to the full-image path below.
              }
            }

            const direct = cached.find(a => isBackdropRow(a) && a.data_len > 0 && a.image_url === picked.url);
            if (direct) return serveArtworkRow(req, direct, 86400);
            const imgRes = await fetch(picked.url);
            if (!imgRes.ok) return new Response('', { status: 404 });
            const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
            const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
            db.saveShowArtwork(show.id, 15, picked.url, picked.width, picked.height, undefined, imgBytes, contentType);
            return new Response(imgBytes, {
              headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" },
            });
          }

          const backdropArt = cached.find(a => isBackdropRow(a) && a.data_len > 0);
          if (backdropArt) return serveArtworkRow(req, backdropArt, 86400);

          const provider = ProviderFactory.getProvider(show.provider_type, config);

          let backdropUrl: string | null = null;
          let artType = 0;

          if (show.provider_type === "tvdb") {
            const tvdb = provider as TVDBProvider;
            for (const at of [3, 15]) {
              const artworks = await tvdb.getSeriesArtworks(show.provider_id, at);
              const art = artworks[0];
              if (art?.image) {
                backdropUrl = art.image;
                artType = at;
                db.saveShowArtwork(show.id, at, art.image,
                  art.width ?? undefined,
                  art.height ?? undefined,
                  art.thumbnail ?? undefined);
                break;
              }
            }
          }

          if (!backdropUrl) {
            const showData = await provider.getShow(show.provider_id);
            backdropUrl = extractBackdropUrl(show.provider_type, showData.metadata);
          }

          if (!backdropUrl) return new Response('', { status: 404 });

          const imgRes = await fetch(backdropUrl);
          if (!imgRes.ok) return new Response('', { status: 404 });

          const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
          const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
          if (artType) db.saveShowArtwork(show.id, artType, backdropUrl, undefined, undefined, undefined, imgBytes, contentType);

          return new Response(imgBytes, {
            headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" },
          });
        } catch {
          return new Response('', { status: 404 });
        }
      },
    },

    "/api/shows/:id/images/backdrops": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return errorResponse("Show not found", 404);
          // DB first: a persisted list answers instantly. Refresh happens in
          // the background when stale (>7 days) so opens never wait on the
          // provider; a show with no stored list pays one live fetch.
          const stored = db.getShowBackdropOptions(show.id);
          const stale = Date.now() - db.getShowBackdropOptionsAt(show.id) > 7 * 24 * 3600 * 1000;
          if (stored.length > 0) {
            if (stale) {
              listBackdropOptions(show, loadConfig()).then((live) => {
                const d = dedupeBackdropOptions(live);
                if (d.length > 0) db.saveShowBackdropOptions(show.id, d);
              }).catch(() => {});
            }
            return json({
              options: stored,
              selected: clampBackdropIndex(stored, db.getShowBackdropIndex(show.id)),
              position: db.getShowBackdropPosition(show.id),
            });
          }
          const options = dedupeBackdropOptions(await listBackdropOptions(show, loadConfig()));
          if (options.length > 0) db.saveShowBackdropOptions(show.id, options);
          return json({
            options,
            selected: clampBackdropIndex(options, db.getShowBackdropIndex(show.id)),
            position: db.getShowBackdropPosition(show.id),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/images/poster/:source/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        const source = req.params.source!;
        if (!isProviderType(source)) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);
          const show = await provider.getShow(req.params.id!);
          const posterUrl = extractPosterUrl(source, show.metadata);

          if (!posterUrl) {
            return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
          }

          const imgRes = await fetch(posterUrl);
          if (!imgRes.ok) {
            return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
          }

          return new Response(imgRes.body, {
            headers: {
              "Content-Type": imgRes.headers.get("Content-Type") ?? "image/jpeg",
              "Cache-Control": "public, max-age=21600",
            },
          });
        } catch (err) {
          console.warn(`[api] poster fetch failed for ${source}/${req.params.id!}:`, err);
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
      },
    },

    "/api/images/backdrop/:source/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        const source = req.params.source!;
        if (!isProviderType(source)) {
          return new Response('', { status: 404 });
        }
        const showId = req.params.id!;
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);

          let backdropUrl: string | null = null;

          if (source === "tvdb") {
            const tvdb = provider as TVDBProvider;
            for (const artType of [3, 15]) {
              const artworks = await tvdb.getSeriesArtworks(showId, artType);
              const art = artworks[0];
              if (art?.image) {
                backdropUrl = art.image;
                db.saveShowArtwork(showId, artType, art.image,
                  art.width ?? undefined,
                  art.height ?? undefined,
                  art.thumbnail ?? undefined);
                break;
              }
            }
          }

          if (!backdropUrl) {
            const show = await provider.getShow(showId);
            backdropUrl = extractBackdropUrl(source, show.metadata);
          }

          if (!backdropUrl) {
            // No backdrop artwork exists; fall back to the poster so the UI
            // never receives a 404 for the banner slot.
            const show = await provider.getShow(showId);
            const posterUrl = extractPosterUrl(source, show.metadata);
            if (!posterUrl) return new Response('', { status: 404 });
            return fetch(posterUrl).then(imgRes => {
              if (!imgRes.ok) return new Response('', { status: 404 });
              const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
              return new Response(imgRes.body, {
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": "public, max-age=21600",
                },
              });
            });
          }

          const imgRes = await fetch(backdropUrl);
          if (!imgRes.ok) {
            return new Response('', { status: 404 });
          }

          const imgBuffer = await imgRes.arrayBuffer();
          const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
          db.saveShowArtwork(showId, 15, backdropUrl, undefined, undefined, undefined, new Uint8Array(imgBuffer), contentType);

          return new Response(imgBuffer, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=21600",
            },
          });
        } catch {
          return new Response('', { status: 404 });
        }
      },
    },

    "/api/images/artwork/:source/:id/:type": {
      async GET(req: Request & { params: Record<string, string> }) {
        const source = req.params.source!;
        if (!isProviderType(source)) {
          return new Response('', { status: 404 });
        }
        const type = parseInt(req.params.type!, 10);
        if (Number.isNaN(type)) {
          return new Response('', { status: 400 });
        }

        const showId = req.params.id!;
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);

          const existing = db.getShowArtworkMeta(showId, type);
          const cached = existing[0];

          if (cached && cached.data_len > 0) return serveArtworkRow(req, cached, 86400);

          if (source === "tvdb") {
            const tvdb = provider as TVDBProvider;
            let artworks = existing;
            if (artworks.length === 0) {
              try {
                const seriesArtworks = await tvdb.getSeriesArtworks(showId, type);
                for (const art of seriesArtworks) {
                  db.saveShowArtwork(showId, art.type, art.image,
                    art.width ?? undefined,
                    art.height ?? undefined,
                    art.thumbnail ?? undefined);
                }
                artworks = db.getShowArtworkMeta(showId, type);
              } catch (e) {
                console.warn(`[api] tvdb getSeriesArtworks failed:`, e);
              }
            }
            const artwork = artworks[0];
            if (artwork?.image_url) {
              const imgRes = await fetch(artwork.image_url);
              if (imgRes.ok) {
                const imgBuffer = await imgRes.arrayBuffer();
                const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
                db.saveShowArtwork(showId, type, artwork.image_url, artwork.width ?? undefined, artwork.height ?? undefined, artwork.thumbnail ?? undefined, new Uint8Array(imgBuffer), contentType);
                return new Response(imgBuffer, {
                  headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
                });
              }
            }
          }

          const show = await provider.getShow(showId);
          let imgUrl: string | null = null;
          if (type === 2) {
            imgUrl = extractBackdropUrl(source, show.metadata);
          }
          if (!imgUrl) {
            imgUrl = extractPosterUrl(source, show.metadata);
          }
          if (!imgUrl) return new Response('', { status: 404 });

          const imgRes = await fetch(imgUrl);
          if (!imgRes.ok) return new Response('', { status: 404 });

          const imgBuffer = await imgRes.arrayBuffer();
          const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
          db.saveShowArtwork(showId, type, imgUrl, undefined, undefined, undefined, new Uint8Array(imgBuffer), contentType);

          return new Response(imgBuffer, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=21600",
            },
          });
        } catch (err) {
          console.warn(`[api] artwork fetch failed for ${source}/${showId}/${type}:`, err);
          return new Response('', { status: 404 });
        }
      },
    },

  };
}
