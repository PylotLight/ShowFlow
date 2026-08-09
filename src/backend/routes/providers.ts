import { db } from "../db";
import { ProviderFactory } from "../providers/factory";
import type { ProviderType } from "../providers/factory";
import { json, errorResponse, loadConfig, isProviderType } from "./_shared";

export function providerRoutes() {
  return {

    "/api/providers": {
      async GET() {
        try {
          const config = loadConfig();
          const types: ProviderType[] = ["tvdb", "tmdb", "anilist"];
          return json(
            types.map((type) => {
              const provider = ProviderFactory.getProvider(type, config);
              return {
                id: type,
                configured: provider.isConfigured(),
              };
            }),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/providers/:source/search": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const source = req.params.source!;
          if (!isProviderType(source)) {
            return errorResponse(`Unknown source "${source}".`);
          }
          const url = new URL(req.url);
          const q = url.searchParams.get("q");
          if (!q || q.trim().length === 0) return json([]);

          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);
          if (!provider.isConfigured()) {
            return errorResponse(`Source "${source}" is not configured.`, 400);
          }
          const results = await provider.searchShow(q);
          return json(
            results.slice(0, 12).map((r) => {
              const existing = db.getShowByProvider(source, r.id);
              const meta = r.metadata as Record<string, any> | undefined;
              let originalTitle = r.originalTitle;
              let romanizedTitle = r.romanizedTitle;
              if (!originalTitle && meta) {
                if (source === "tmdb") originalTitle = meta.original_name;
                else if (source === "anilist") {
                  originalTitle = meta.title?.native;
                  romanizedTitle = romanizedTitle ?? meta.title?.romaji;
                }
              }
              return {
                id: r.id,
                title: r.title,
                originalTitle: originalTitle ?? null,
                romanizedTitle: romanizedTitle ?? null,
                year: r.year,
                providerType: source,
                posterUrl: `/api/images/poster/${source}/${r.id}`,
                backdropUrl: `/api/images/backdrop/${source}/${r.id}`,
                existingShowId: existing?.id || null,
                overview: source === "tmdb" ? meta?.overview : source === "anilist" ? meta?.description : null,
                type: source === "anilist" ? meta?.format : null,
                rating: normalizeRating(source, meta),
                status: normalizeStatus(source, { metadata: meta }),
              };
            }),
          );
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json() as { ids?: string[]; posterRefresh?: boolean };
          const source = req.params.source!;
          if (!isProviderType(source)) return errorResponse(`Unknown source "${source}".`);
          const ids = Array.isArray(body.ids) ? body.ids : [];

          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);
          if (!provider.isConfigured()) {
            return errorResponse(`Source "${source}" is not configured.`, 400);
          }

          const results = [];
          for (const id of ids.slice(0, 50)) {
            try {
              const r = await provider.getShow(id);
              results.push({
                id: r.id,
                title: r.title,
                originalTitle: r.originalTitle ?? null,
                romanizedTitle: r.romanizedTitle ?? null,
                year: r.year,
                providerType: source,
                posterUrl: `/api/images/poster/${source}/${r.id}`,
                backdropUrl: `/api/images/backdrop/${source}/${r.id}`,
                existingShowId: db.getShowByProvider(source, r.id)?.id || null,
                overview: source === "tmdb" ? r.metadata?.overview : source === "anilist" ? r.metadata?.description : null,
                type: source === "anilist" ? r.metadata?.format : null,
                genres: source === "tmdb" ? (r.metadata?.genres ?? []).map((g: any) => g.name) : source === "anilist" ? r.metadata?.genres : null,
                rating: normalizeRating(source, r.metadata),
                status: normalizeStatus(source, r),
              });
            } catch (err) {
              console.warn(`[api] provider bulk detail failed for ${source}/${id}:`, err);
            }
          }
          return json(results);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/providers/:source/show/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        const source = req.params.source!;
        if (!isProviderType(source)) {
          return errorResponse(`Unknown source "${source}".`);
        }
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);
          if (!provider.isConfigured()) {
            return errorResponse(`Source "${source}" is not configured.`, 400);
          }
          const [show, seasons] = await Promise.all([
            provider.getShow(req.params.id!),
            provider.getSeasons(req.params.id!).catch(() => []),
          ]);
          return json({
            id: show.id,
            title: show.title,
            originalTitle: show.originalTitle ?? null,
            romanizedTitle: show.romanizedTitle ?? null,
            year: show.year,
            providerType: source,
            posterUrl: `/api/images/poster/${source}/${show.id}`,
            backdropUrl: `/api/images/backdrop/${source}/${show.id}`,
            overview: toOverview(source, show),
            genres: toGenres(source, show),
            rating: normalizeRating(source, show.metadata),
            status: normalizeStatus(source, show),
            type: normalizeSeriesType(source, show),
            episodeCount: toEpisodeCount(source, show),
            seasonCount: toSeasonCount(source, show),
            creators: toCreators(source, show),
            networks: toNetworks(source, show),
            firstAirDate: toFirstAirDate(source, show),
            seasons: seasons.map((s) => ({
              id: s.id,
              number: s.number,
              name: s.name,
            })),
            links: toLinks(source, show),
          });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/shows/:id/providers": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const providers = db.listShowProvidersWithRoles(req.params.id!);
          return json(providers.map(p => ({
            type: p.provider_type,
            id: p.provider_id,
            title: p.title,
            isPrimary: !!p.is_primary,
            lastSynced: p.last_synced,
            roles: p.roles,
          })));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const { providerType, providerId } = await req.json();
          if (!providerType || !providerId) {
            return errorResponse("providerType and providerId are required");
          }
          db.addShowProvider(req.params.id!, providerType, providerId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeShowProvider(req.params.id!, req.params.type!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type/primary": {
      async PUT(req: Request & { params: Record<string, string> }) {
        try {
          db.setPrimaryProvider(req.params.id!, req.params.type!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type/role": {
      async PUT(req: Request & { params: Record<string, string> }) {
        try {
          const { role, active } = await req.json();
          if (!role || !['metadata', 'airtime'].includes(role)) {
            return errorResponse("role must be 'metadata' or 'airtime'");
          }
          db.setProviderRole(req.params.id!, req.params.type!, role as 'metadata' | 'airtime', !!active);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

  };
}

// ---- Detail normalization helpers -----------------------------------------

function metaOf(show: { metadata?: Record<string, any> }): Record<string, any> | undefined {
  return show.metadata as Record<string, any> | undefined;
}

export function normalizeRating(
  source: ProviderType,
  meta: Record<string, any> | undefined,
): number | null {
  if (!meta) return null;
  if (source === "tmdb" && typeof meta.vote_average === "number") return meta.vote_average;
  if (source === "anilist" && typeof meta.averageScore === "number") return meta.averageScore / 10;
  if (source === "tvdb" && typeof meta.score === "number") return meta.score / 10;
  return null;
}

export function normalizeStatus(
  source: ProviderType,
  input: { metadata?: Record<string, any> },
): string | null {
  const meta = metaOf(input);
  if (!meta) return null;
  if (source === "tmdb" && typeof meta.status === "string") return meta.status;
  if (source === "anilist" && typeof meta.status === "string") {
    return meta.status === "RELEASING" ? "Airing" : meta.status;
  }
  if (source === "tvdb" && typeof meta.status === "string") return meta.status;
  return null;
}

function toOverview(source: ProviderType, show: { metadata?: Record<string, any> }): string | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb") return typeof meta.overview === "string" ? meta.overview : null;
  if (source === "anilist") return typeof meta.description === "string" ? stripHtml(meta.description) : null;
  if (source === "tvdb") return typeof meta.overview === "string" ? meta.overview : null;
  return null;
}

function toGenres(source: ProviderType, show: { metadata?: Record<string, any> }): string[] | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && Array.isArray(meta.genres)) return meta.genres.map((g: any) => g.name ?? null).filter(Boolean);
  if (source === "anilist" && Array.isArray(meta.genres)) return meta.genres;
  if (source === "tvdb" && Array.isArray(meta.genres)) return meta.genres;
  return null;
}

function normalizeSeriesType(source: ProviderType, show: { metadata?: Record<string, any> }): string | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "anilist") return typeof meta.format === "string" ? meta.format : null;
  if (source === "tmdb") return typeof meta.type === "string" ? meta.type : "tv";
  if (source === "tvdb" && Array.isArray(meta.genres)) {
    const types = ["scripted", "mini-series", "reality"];
    const hit = meta.genres.find((g: any) => typeof g === "string" && types.includes(g.toLowerCase()));
    if (hit) return ["scripted", "mini-series", "reality"].find((t) => t === hit.toLowerCase()) ?? null;
  }
  return null;
}

function toEpisodeCount(source: ProviderType, show: { metadata?: Record<string, any> }): number | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && typeof meta.number_of_episodes === "number") return meta.number_of_episodes;
  if (source === "anilist" && typeof meta.episodes === "number") return meta.episodes;
  return null;
}

function toSeasonCount(source: ProviderType, show: { metadata?: Record<string, any> }): number | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && typeof meta.number_of_seasons === "number") return meta.number_of_seasons;
  if (source === "tvdb" && Array.isArray(meta.seasons) && meta.seasons.length) return meta.seasons.length;
  return 1;
}

function toCreators(source: ProviderType, show: { metadata?: Record<string, any> }): string[] | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && Array.isArray(meta.created_by)) return meta.created_by.map((c: any) => c?.name ?? null).filter(Boolean);
  if (source === "anilist" && Array.isArray(meta.studios?.nodes)) return meta.studios.nodes.map((s: any) => s?.name ?? null).filter(Boolean);
  return null;
}

function toNetworks(source: ProviderType, show: { metadata?: Record<string, any> }): string[] | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && Array.isArray(meta.networks)) return meta.networks.map((n: any) => n?.name ?? null).filter(Boolean);
  if (source === "anilist" && Array.isArray(meta.studios?.nodes)) return meta.studios.nodes.map((s: any) => s?.name ?? null).filter(Boolean);
  return null;
}

function toFirstAirDate(source: ProviderType, show: { metadata?: Record<string, any> }): string | null {
  const meta = metaOf(show);
  if (!meta) return null;
  if (source === "tmdb" && typeof meta.first_air_date === "string") return meta.first_air_date;
  if (source === "anilist" && meta.startDate?.year) return String(meta.startDate.year);
  if (source === "tvdb" && typeof meta.first_air_time === "string") return meta.first_air_time.slice(0, 10);
  return null;
}

function toLinks(source: ProviderType, show: { metadata?: Record<string, any>; id: string }): Array<{ label: string; url: string }> {
  const meta = metaOf(show) as any;
  const links: Array<{ label: string; url: string }> = [];

  const imdbId =
    meta?.imdb_id ?? meta?.imdbId ?? meta?.external_ids?.imdb_id ?? null;
  const tvdbId =
    meta?.tvdb_id ?? meta?.external_ids?.tvdb_id ?? null;
  const malId =
    meta?.idMal ?? null;
  const anilistExternal = Array.isArray(meta?.externalLinks)
    ? meta.externalLinks.filter((l: any) => l?.url)
    : [];

  if (source === "tmdb") {
    links.push({ label: "TMDB", url: `https://www.themoviedb.org/tv/${show.id}` });
  }
  if (source === "anilist") {
    links.push({ label: "AniList", url: `https://anilist.co/anime/${show.id}` });
  }
  if (source === "tvdb" || tvdbId) {
    links.push({ label: "TVDB", url: `https://www.thetvdb.com/dereferrer/series/${tvdbId ?? show.id}` });
  }
  if (imdbId) {
    links.push({ label: "IMDb", url: `https://www.imdb.com/title/${imdbId}` });
  }
  if (malId) {
    links.push({ label: "MyAnimeList", url: `https://myanimelist.net/anime/${malId}` });
  }
  for (const link of anilistExternal) {
    const site = typeof link.site === "string" ? link.site : null;
    if (!site) continue;
    const known = ["Crunchyroll", "MAL", "MyAnimeList"].some((n) => site.toLowerCase().includes(n.toLowerCase()));
    if (!known) continue;
    links.push({ label: site, url: link.url });
  }

  return links;
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
