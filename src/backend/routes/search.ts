import { db } from "../db";
import { IndexerFactory } from "../providers/indexers/factory";
import type { NativeIndexerId, NativeIndexerConfig } from "../providers/indexers/native/types";
import { NATIVE_INDEXER_META } from "../providers/indexers/native/types";
import type { SystemManager } from "../core/system_manager";
import { json, errorResponse, getProwlarrIndexer, getNativeIndexers, serializeRelease } from "./_shared";

export function searchRoutes(systemManager: SystemManager) {
  return {

    "/api/search": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q");
          if (!query || query.trim().length === 0) return json([]);

          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const categories = url.searchParams.getAll("category").map(c => parseInt(c, 10)).filter(c => !Number.isNaN(c));
          const type = (url.searchParams.get("type") as "search" | "tvsearch" | "movie" | "music" | "book" | null) ?? undefined;

          const allResults: any[] = [];

          const prowlarr = getProwlarrIndexer();
          if (prowlarr) {
            try {
              const results = await prowlarr.search(query, { categories: categories.length ? categories : undefined, type });
              allResults.push(...results);
            } catch (e) {
              console.error('[api] Prowlarr search error:', e);
            }
          }

          const natives = getNativeIndexers();
          await Promise.all(natives.map(async ({ instance }) => {
            try {
              const results = await instance.search(query, { categories: categories.length ? categories : undefined, type });
              allResults.push(...results);
            } catch (e) {
              console.error(`[api] Native indexer ${instance.name} search error:`, e);
            }
          }));

          const sliced = allResults.slice(0, Number.isNaN(limit) ? 50 : limit);
          return json(sliced);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/search/grab": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const release = await req.json();
          if (!release?.guid) {
            return errorResponse("A full release object (as returned by /api/search) is required.");
          }

          let ok = false;
          let message: string | undefined;

          const torbox = systemManager.getWatcher()?.getTorboxClient();
          if (torbox) {
            const result = await torbox.submitReleaseBackground(release);
            ok = result.ok;
            message = result.message;
          } else {
            const prowlarr = getProwlarrIndexer();
            if (prowlarr) {
              ok = await prowlarr.grab(release);
            }
            if (!ok) {
              const natives = getNativeIndexers();
              const match = natives.find(n => release.indexerName === n.instance.name)?.instance;
              if (match) {
                ok = await match.grab(release);
              }
            }
          }

          if (ok) {
            db.logEvent({ type: "grab", entityType: "release", message: message || `Grabbed ${release.title}` });
          }
          return json({ success: ok, message: message || (ok ? `Grabbed ${release.title}` : `Grab failed for "${release.title}". Check that a Download Client is configured.`) });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/indexers/prowlarr/status": {
      async GET() {
        try {
          const indexer = getProwlarrIndexer();
          if (!indexer) return json({ ok: false, message: "Prowlarr not configured" });
          const result = await indexer.validate();
          return json(result);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/indexers/prowlarr/indexers": {
      async GET() {
        try {
          const indexer = getProwlarrIndexer();
          if (!indexer) return json({ ok: false, message: "Prowlarr not configured" });
          const indexers = await indexer.listIndexers();
          return json(indexers);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/indexers/native/meta": {
      async GET() {
        try {
          return json(
            Object.entries(NATIVE_INDEXER_META).map(([id, meta]) => ({
              id,
              ...meta,
            }))
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/indexers/native/status": {
      async GET() {
        try {
          const natives = getNativeIndexers();
          const results = await Promise.all(
            natives.map(async ({ config, instance }) => {
              const status = await instance.validate();
              return { id: config.id, name: instance.name, ...status };
            })
          );
          return json(results);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/indexers/native/test/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const rawId = req.params.id!;
          if (!rawId || !(rawId in NATIVE_INDEXER_META)) {
            return errorResponse(`Unknown native indexer: ${rawId}`, 400);
          }
          const id = rawId as NativeIndexerId;
          const raw = db.getSetting('nativeIndexers');
          const configs: NativeIndexerConfig[] = raw ? JSON.parse(typeof raw === 'string' ? raw : raw) : [];
          const cfg = configs.find(c => c.id === id);
          const instance = IndexerFactory.createNative(cfg ?? { id, enabled: true });
          const result = await instance.validate();
          return json(result);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

  };
}
