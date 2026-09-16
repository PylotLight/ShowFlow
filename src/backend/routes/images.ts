import { db } from "../db";
import { ProviderFactory } from "../providers/factory";
import { TVDBProvider } from "../providers/tvdb";
import { TMDBProvider } from "../providers/tmdb";
import type { ProviderType } from "../providers/factory";
import { json, errorResponse, loadConfig, isProviderType, extractPosterUrl, extractBackdropUrl, NO_SIGNAL_SVG } from "./_shared";

export interface BackdropOption {
  index: number;
  url: string;
  width?: number;
  height?: number;
}

/** De-duplicate provider artwork lists by URL, assigning stable indexes. */
export function dedupeBackdropOptions(items: { url?: string | null; width?: number; height?: number }[]): BackdropOption[] {
  const seen = new Set<string>();
  const out: BackdropOption[] = [];
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({ index: out.length, url: item.url, width: item.width, height: item.height });
  }
  return out;
}

/** Clamp a stored/selected index against the live option list. */
export function clampBackdropIndex(options: BackdropOption[], stored: number): number {
  if (options.length === 0) return 0;
  if (!Number.isFinite(stored) || stored < 0) return 0;
  return Math.min(Math.floor(stored), options.length - 1);
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
async function listBackdropOptions(show: any, config: any): Promise<{ url: string; width?: number; height?: number }[]> {
  try {
    if (show.provider_type === "tvdb") {
      const tvdb = ProviderFactory.getProvider("tvdb", config) as TVDBProvider;
      const out: { url: string; width?: number; height?: number }[] = [];
      for (const at of [3, 15]) {
        const arts = await tvdb.getSeriesArtworks(show.provider_id, at);
        for (const a of arts) {
          if (a?.image) out.push({
            url: a.image,
            width: a.width ?? undefined,
            height: a.height ?? undefined,
          });
        }
      }
      if (out.length > 0) return out;
    } else if (show.provider_type === "tmdb") {
      const tmdb = ProviderFactory.getProvider("tmdb", config) as TMDBProvider;
      const backs = await tmdb.getBackdrops(show.provider_id);
      if (backs.length > 0) return backs;
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
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });

          const cached = db.getShowArtworks(show.id, 2) as any[];
          if (cached.length > 0 && cached[0].data) {
            const contentType = cached[0].content_type ?? "image/jpeg";
            const cacheControl = `public, max-age=${cached[0].image_url ? 86400 : 3600}`;
            return new Response(cached[0].data, { headers: { "Content-Type": contentType, "Cache-Control": cacheControl } });
          }

          const config = loadConfig();
          const provider = ProviderFactory.getProvider(show.provider_type, config);
          const showData = await provider.getShow(show.provider_id);
          const posterUrl = extractPosterUrl(show.provider_type, showData.metadata);

          if (!posterUrl) {
            return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
          }

          const imgRes = await fetch(posterUrl);
          if (!imgRes.ok) {
            return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
          }

          const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
          const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
          db.saveShowArtwork(show.id, 2, posterUrl, undefined, undefined, undefined, imgBytes, contentType);

          return new Response(imgBytes, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=21600",
            },
          });
        } catch (err) {
          console.warn(`[api] poster fetch failed for show ${req.params.id!}:`, err);
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
      },
    },

    "/api/shows/:id/images/backdrop": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return new Response('', { status: 404 });

          const cached = db.getShowArtworks(show.id) as any[];
          const config = loadConfig();
          const requestedParam = new URL(req.url).searchParams.get("index");
          const requested = requestedParam != null ? parseInt(requestedParam, 10) : NaN;

          // When the provider exposes multiple backdrops, serve the
          // requested (or stored) selection. The cached-bytes fast path
          // only applies when the cached row is this exact URL — otherwise
          // a stale pick would stick after cycling.
          const options = dedupeBackdropOptions(await listBackdropOptions(show, config));
          if (options.length > 0) {
            const stored = db.getShowBackdropIndex(show.id);
            const idx = clampBackdropIndex(options, Number.isFinite(requested) ? requested : stored);
            const picked = options[idx]!;
            const direct = cached.find(a => isBackdropRow(a) && a.data && a.image_url === picked.url);
            if (direct) {
              return new Response(direct.data, {
                headers: { "Content-Type": direct.content_type ?? "image/jpeg", "Cache-Control": "public, max-age=86400" },
              });
            }
            const imgRes = await fetch(picked.url);
            if (!imgRes.ok) return new Response('', { status: 404 });
            const contentType = imgRes.headers.get("Content-Type") ?? "image/jpeg";
            const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
            db.saveShowArtwork(show.id, 15, picked.url, picked.width, picked.height, undefined, imgBytes, contentType);
            return new Response(imgBytes, {
              headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" },
            });
          }

          const backdropArt = cached.find(a => isBackdropRow(a) && a.data);
          if (backdropArt) {
            const contentType = backdropArt.content_type ?? "image/jpeg";
            return new Response(backdropArt.data, {
              headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
            });
          }

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
          const options = dedupeBackdropOptions(await listBackdropOptions(show, loadConfig()));
          return json({ options, selected: clampBackdropIndex(options, db.getShowBackdropIndex(show.id)) });
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

          const existing = db.getShowArtworks(showId, type);
          const cached = existing[0];

          if (cached?.data) {
            return new Response(cached.data, {
              headers: {
                "Content-Type": cached.content_type ?? "image/jpeg",
                "Cache-Control": "public, max-age=86400",
              },
            });
          }

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
                artworks = db.getShowArtworks(showId, type);
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
                db.saveShowArtwork(showId, type, artwork.image_url, artwork.width, artwork.height, artwork.thumbnail, new Uint8Array(imgBuffer), contentType);
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
