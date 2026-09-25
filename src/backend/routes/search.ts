import { db } from "../db";
import { IndexerFactory } from "../providers/indexers/factory";
import type { NativeIndexerId, NativeIndexerConfig } from "../providers/indexers/native/types";
import { NATIVE_INDEXER_META } from "../providers/indexers/native/types";
import type { SystemManager } from "../core/system_manager";
import { json, errorResponse, getProwlarrIndexer, getNativeIndexers, serializeRelease, loadConfig } from "./_shared";

/** Build a minimal release from a pasted magnet link so it can flow through the normal grab path. */
function buildManualMagnetRelease(body: any) {
  const rawMagnet = typeof body?.magnet === "string" ? body.magnet
    : typeof body?.magnetUrl === "string" ? body.magnetUrl : null;
  const magnetUrl = rawMagnet?.trim() ?? "";
  if (!magnetUrl.startsWith("magnet:")) {
    return { error: "A magnet link starting with \"magnet:\" is required." };
  }
  const hashMatch = magnetUrl.match(/xt=urn:btih:([^&]+)/i);
  const infoHash = hashMatch?.[1]?.trim() ?? "";
  if (!infoHash) {
    return { error: "That magnet link has no btih info hash (xt=urn:btih:...)." };
  }
  let dn: string | null = null;
  const dnMatch = magnetUrl.match(/[?&]dn=([^&]+)/);
  if (dnMatch?.[1]) {
    try {
      dn = decodeURIComponent(dnMatch[1].replace(/\+/g, " "));
    } catch {
      dn = dnMatch[1];
    }
  }
  const title = (typeof body?.title === "string" && body.title.trim()) || dn || `Magnet ${infoHash.slice(0, 8)}`;
  return {
    release: {
      guid: `manual-${infoHash.toLowerCase()}`,
      indexerId: -1,
      indexerName: "Manual magnet",
      title,
      seeders: 0,
      leechers: 0,
      grabs: 0,
      size: 0,
      publishDate: new Date().toISOString(),
      ageHours: 0,
      infoUrl: "",
      downloadUrl: "",
      magnetUrl,
      infoHash: infoHash.toLowerCase(),
      protocol: "torrent" as const,
      categories: [],
      indexerFlags: [],
      isPack: false,
    },
  };
}

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

    "/api/search/adhoc": {
      /**
       * Adhoc indexer search, disconnected from shows/releases.
       * Query params:
       *   q         free-text query (required)
       *   limit     max merged results (default 50)
       *   type      search | tvsearch | movie | music | book (default search)
       *   category  Newznab category id, repeatable (absent = all)
       *   indexer   Prowlarr indexer id, repeatable (absent = all Prowlarr indexers,
       *             searched in one call and reported as a single entry)
       *   native    native indexer id (nyaa, knaben, ...), repeatable
       *             (absent = all enabled natives, each reported separately)
       * Response: { results, indexers: [{ key, kind, name, ok, ms, count, error? }], total }
       */
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q");
          if (!query || query.trim().length === 0) {
            return json({ results: [], indexers: [], total: 0 });
          }

          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const categories = url.searchParams.getAll("category").map(c => parseInt(c, 10)).filter(c => !Number.isNaN(c));
          const type = (url.searchParams.get("type") as "search" | "tvsearch" | "movie" | "music" | "book" | null) ?? "search";
          const indexerIds = url.searchParams.getAll("indexer").map(c => parseInt(c, 10)).filter(c => !Number.isNaN(c));
          const nativeIds = url.searchParams.getAll("native");

          const allResults: any[] = [];
          const stats: { key: string; kind: string; name: string; ok: boolean; ms: number; count: number; error?: string }[] = [];

          async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
            const start = Date.now();
            try {
              const value = await fn();
              return { value, ms: Date.now() - start };
            } catch (e) {
              return { ms: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
            }
          }

          const jobs: Promise<void>[] = [];

          const prowlarr = getProwlarrIndexer();
          if (prowlarr) {
            // Map Prowlarr indexer ids to names for the stats entries (best-effort).
            const indexersById = new Map<number, string>();
            try {
              const list = await prowlarr.listIndexers();
              for (const i of list) indexersById.set(i.id, i.name);
            } catch {
              // Name lookup is cosmetic; the search below still runs.
            }
            if (indexerIds.length > 0) {
              // One call per selected indexer so stats are truly per-indexer.
              for (const id of indexerIds) {
                jobs.push((async () => {
                  const r = await timed(() => prowlarr.search(query, {
                    categories: categories.length ? categories : undefined,
                    type,
                    indexerIds: [id],
                  }));
                  const results = r.value ?? [];
                  allResults.push(...results);
                  stats.push({
                    key: `prowlarr:${id}`,
                    kind: "prowlarr",
                    name: indexersById.get(id) ?? `Prowlarr #${id}`,
                    ok: !r.error,
                    ms: r.ms,
                    count: results.length,
                    ...(r.error ? { error: r.error } : {}),
                  });
                })());
              }
            } else {
              jobs.push((async () => {
                const r = await timed(() => prowlarr.search(query, {
                  categories: categories.length ? categories : undefined,
                  type,
                }));
                const results = r.value ?? [];
                allResults.push(...results);
                stats.push({
                  key: "prowlarr:all",
                  kind: "prowlarr",
                  name: "Prowlarr (all)",
                  ok: !r.error,
                  ms: r.ms,
                  count: results.length,
                  ...(r.error ? { error: r.error } : {}),
                });
              })());
            }
          }

          const natives = getNativeIndexers().filter(({ config }) =>
            nativeIds.length === 0 || nativeIds.includes(config.id)
          );
          for (const { config, instance } of natives) {
            jobs.push((async () => {
              const r = await timed(() => instance.search(query, {
                categories: categories.length ? categories : undefined,
                type,
              }));
              const results = r.value ?? [];
              allResults.push(...results);
              stats.push({
                key: `native:${config.id}`,
                kind: "native",
                name: instance.name,
                ok: !r.error,
                ms: r.ms,
                count: results.length,
                ...(r.error ? { error: r.error } : {}),
              });
            })());
          }

          await Promise.all(jobs);
          stats.sort((a, b) => a.name.localeCompare(b.name));

          const sliced = allResults.slice(0, Number.isNaN(limit) ? 50 : limit);
          return json({ results: sliced, indexers: stats, total: allResults.length });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/search/grab": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          let release = body;
          let isManualMagnet = false;

          if (!release?.guid) {
            // Direct magnet paste: synthesize a release so it flows through
            // the normal TorBox / blackhole grab path.
            const manual = buildManualMagnetRelease(body);
            if (!("release" in manual) || !manual.release) {
              return errorResponse((manual as { error: string }).error ?? "A full release object (as returned by /api/search) or a magnet link is required.");
            }
            release = manual.release;
            isManualMagnet = true;
          }

          let ok = false;
          let message: string | undefined;

          const torbox = systemManager.getWatcher()?.getTorboxClient();
          if (torbox) {
            const result = await torbox.submitReleaseBackground(release);
            ok = result.ok;
            message = result.message;
          } else {
            if (!isManualMagnet) {
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
            if (!ok && release.magnetUrl?.startsWith("magnet:")) {
              // Manual magnets (and any magnet release when no indexer grab
              // claimed it): write the .magnet straight to the blackhole
              // output folder — same artifact an indexer grab would produce.
              try {
                const outputFolder = loadConfig().downloadClient?.blackhole?.outputFolder?.trim();
                if (outputFolder) {
                  const hash = release.infoHash || release.magnetUrl.match(/btih:([a-fA-F0-9]+)/i)?.[1] || crypto.randomUUID();
                  await Bun.file(`${outputFolder}/${hash}.magnet`).write(release.magnetUrl);
                  ok = true;
                  message = `Wrote magnet for "${release.title}" to blackhole output`;
                }
              } catch (e) {
                console.error("[api] Manual magnet blackhole write failed:", e);
              }
            }
          }

          if (ok) {
            db.logEvent({ type: "grab", entityType: "release", message: message || `Grabbed ${release.title}` });
            // Movie provenance: the interactive movie browser posts its
            // show id alongside the release so later imports can pin the
            // film even when the filename is generic.
            if (typeof release?.movieShowId === "string" && release.movieShowId) {
              try {
                db.recordGrabbedRelease({
                  showId: release.movieShowId,
                  releaseTitle: release.title,
                  indexerName: release.indexerName ?? null,
                  publishDate: release.publishDate ?? null,
                });
              } catch {}
            }
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
