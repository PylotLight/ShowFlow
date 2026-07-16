import { db } from "../db";
import { ProviderFactory } from "../providers/factory";
import type { ProviderType } from "../providers/factory";
import { json, errorResponse, loadConfig, isProviderType } from "./_shared";

export function providerRoutes() {
  return {

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
                existingShowId: existing?.id || null,
                overview: source === "tmdb" ? meta?.overview : source === "anilist" ? meta?.description : null,
                type: source === "anilist" ? meta?.format : null,
              };
            }),
          );
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
