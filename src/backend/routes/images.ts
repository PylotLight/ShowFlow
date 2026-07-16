import { db } from "../db";
import { ProviderFactory } from "../providers/factory";
import { TVDBProvider } from "../providers/tvdb";
import type { ProviderType } from "../providers/factory";
import { json, errorResponse, loadConfig, isProviderType, extractPosterUrl, extractBackdropUrl, NO_SIGNAL_SVG } from "./_shared";

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
          const backdropArt = cached.find(a => (a.artwork_type === "3" || a.artwork_type === "15") && a.data);
          if (backdropArt) {
            const contentType = backdropArt.content_type ?? "image/jpeg";
            return new Response(backdropArt.data, {
              headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
            });
          }

          const config = loadConfig();
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
            return new Response('', { status: 404 });
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
