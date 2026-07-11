import { serve } from "bun";
import fs from "node:fs";
import path from "node:path";
import index from "../frontend/index.html";
import { db, ConfigSchema, ProwlarrConfigSchema, type Config } from "./db";
import { ProviderFactory, type ProviderType } from "./providers/factory";
import { TVDBProvider } from "./providers/tvdb";
import { Scheduler } from "./core/scheduler";
import { SyncManager } from "./core/sync_manager";
import { SystemManager } from "./core/system_manager";
import { Oracle } from "./parser/oracle";
import { GrabberService } from "./core/grabber_service";
import { IndexerFactory } from "./providers/indexers/factory";
import type { IndexerResult } from "./providers/indexers/types";

// ---- Config -----------------------------------------------------------
// Migrated from config.json to database settings.

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const settings = db.getAllSettings();
  const configObj: any = {};
  for (const s of settings) {
    try {
      configObj[s.key] = JSON.parse(s.value);
    } catch {
      configObj[s.key] = s.value;
    }
  }

    if (Object.keys(configObj).length === 0) {
      // Auto-init with defaults for a fresh database
      const configPath = path.join(process.cwd(), "config.json");
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        for (const [k, v] of Object.entries(raw)) {
          db.setSetting(k, v);
        }
        return loadConfig();
      }
      console.info("[config] No config found — applying defaults for fresh database");
      db.setSetting("defaultProvider", "tvdb");
      db.setSetting("onCollision", "skip");
      db.setSetting("dryRun", false);
      db.setSetting("apiKeys", {});
      db.setSetting("downloadClient", { type: "blackhole" });
      return loadConfig();
    }

  cachedConfig = ConfigSchema.parse(configObj);
  return cachedConfig;
}

function invalidateConfigCache() {
  cachedConfig = null;
}

function isProviderType(value: string): value is ProviderType {
  return value === "tmdb" || value === "tvdb" || value === "anilist";
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

function errorResponse(err: unknown, status = 400) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${message}`);
  return json({ error: message }, { status });
}

// ---- Poster resolution --------------------------------------------------
// Providers return raw, un-normalized `metadata` per source. There's no
// shared "posterUrl" field yet, so we derive one here per provider rather
// than changing the shared Show type (that's provider-layer territory).

function extractPosterUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      return metadata.image ?? metadata.artworks?.[0]?.image ?? null;
    case "tmdb":
      return metadata.poster_path ? `https://image.tmdb.org/t/p/w500${metadata.poster_path}` : null;
    case "anilist":
      return metadata.coverImage?.large ?? metadata.coverImage?.medium ?? null;
    default:
      return null;
  }
}

function extractBackdropUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      const fanart = metadata.artworks?.find((a: any) => a.type === 15 || a.type === 3);
      return fanart?.image ?? null;
    case "tmdb":
      return metadata.backdrop_path ? `https://image.tmdb.org/t/p/w1280${metadata.backdrop_path}` : null;
    case "anilist":
      return metadata.bannerImage ?? null;
    default:
      return null;
  }
}

// A tiny 1x1 transparent-ish placeholder isn't very useful in a glass UI, so
// missing posters fall through to this SVG "no signal" card instead of a
// broken-image icon.
function getProwlarrIndexer() {
  const raw = db.getSetting('prowlarr');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = ProwlarrConfigSchema.parse(parsed);
    return IndexerFactory.create('prowlarr', config);
  } catch (err) {
    console.error('[api] Prowlarr is configured but invalid:', err);
    return null;
  }
}

// ScoredRelease carries a live `indexer` instance (needed to grab it) whose
// private fields (including the Prowlarr API key!) are still enumerable at
// runtime despite the `private` keyword being TS-only. Never JSON-serialize
// a release without stripping it first.
function serializeRelease({ indexer, ...rest }: any) {
  return rest;
}

const NO_SIGNAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="oklch(0.19 0.025 265)"/>
  <rect x="0.5" y="0.5" width="499" height="749" fill="none" stroke="oklch(1 0 0 / 10%)"/>
  <circle cx="250" cy="345" r="28" fill="none" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <line x1="230" y1="325" x2="270" y2="365" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <text x="250" y="410" font-family="ui-monospace, monospace" font-size="15" fill="oklch(0.65 0.02 265)" text-anchor="middle">NO SIGNAL</text>
</svg>`;

// ---- Server ---------------------------------------------------------------

const server = serve({
  routes: {
    "/assets/:file": {
      GET(req) {
        const file = req.params.file;
        const ext = file.split(".").pop();
        const types: Record<string, string> = { svg: "image/svg+xml", png: "image/png", css: "text/css", js: "application/javascript" };
        const p = path.join(import.meta.dir, "../../dist/assets", file);
        if (fs.existsSync(p)) {
          return new Response(Bun.file(p), { headers: { "Content-Type": types[ext] || "application/octet-stream" } });
        }
        return new Response("", { status: 404 });
      }
    },

    // Serves the bundled React app for any path that isn't an /api/* route
    // below. This was imported but never wired in - the actual cause of
    // "nothing loads".
    "/*": index,

    "/api/config": {
      async GET() {
        try {
          return json(loadConfig());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async PATCH(req) {
        try {
          const body = (await req.json()) as Partial<Config>;
          for (const [k, v] of Object.entries(body)) {
            db.setSetting(k, v);
          }
          invalidateConfigCache();
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/rootfolders": {
      async GET() {
        try {
          const folders = db.listRootFolders();
          const unmapped = db.getUnmappedFolders();
          const enriched = folders.map(f => {
            const u = unmapped.find(u => u.path === f.path);
            let freeSpace = 0;
            try {
              const stats = fs.statfsSync(f.path);
              freeSpace = stats.bsize * stats.bfree;
            } catch {}
            return {
              path: f.path,
              freeSpace,
              unmappedFolders: u?.subfolders || [],
            };
          });
          return json(enriched);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const { path: folderPath } = await req.json();
          if (!folderPath) return errorResponse("path is required");
          db.addRootFolder(folderPath);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/rootfolders/remove": {
      async POST(req) {
        try {
          const { path: folderPath } = await req.json();
          if (!folderPath) return errorResponse("path is required");
          db.removeRootFolder(folderPath);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/settings": {
      async GET() {
        try {
          return json(db.getAllSettings());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const { key, value } = await req.json();
          if (!key) return errorResponse("Key is required");
          if (key === "prowlarr") {
            const result = ProwlarrConfigSchema.safeParse(value);
            if (!result.success) {
              return errorResponse(result.error.issues.map(i => i.message).join("; "));
            }
            db.setSetting(key, result.data);
            invalidateConfigCache();
            return json({ ok: true });
          }
          db.setSetting(key, value);
          invalidateConfigCache();
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req) {
        try {
          const { key } = await req.json();
          if (!key) return errorResponse("Key is required");
          db.removeSetting(key); 
          invalidateConfigCache();
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/system/scan": {
      async POST() {
        try {
          const result = await systemManager.scan();
          return json({ ok: true, result });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/watch/start": {
      async POST() {
        try {
          const result = await systemManager.startWatcher();
          return json(result);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/watch/stop": {
      async POST() {
        try {
          const result = await systemManager.stopWatcher();
          return json(result);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/status": {
      async GET() {
        try {
          return json({ watching: systemManager.isWatching() });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/system/processing": {
      async GET() {
        try {
          return json(systemManager.getProcessingFiles());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // ---- Activity feed ---------------------------------------------------
    // Backs the dashboard ticker and watcher activity panel. Reads only -
    // events are written by SyncManager and the download watcher.

    "/api/events": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const events = db.listRecentEvents(Number.isNaN(limit) ? 20 : limit);
          return json(
            events.map((e: any) => ({
              id: e.id,
              type: e.event_type,
              entityType: e.entity_type,
              entityId: e.entity_id,
              message: e.message,
              timestamp: e.timestamp,
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/qualities": {
      async GET() {
        try {
          return json(db.listQualities());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const body = await req.json();
          db.saveQuality(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/profiles": {
      async GET() {
        try {
          return json(db.listProfiles());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const body = await req.json();
          db.saveProfile(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/profiles/:id/formats": {
      async GET(req) {
        try {
          return json(db.getProfileFormats(req.params.id));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const { formatId, type } = await req.json();
          db.addProfileFormat(req.params.id, formatId, type);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req) {
        try {
          const { formatId } = await req.json();
          db.removeProfileFormat(req.params.id, formatId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/custom-formats": {
      async GET() {
        try {
          return json(db.listCustomFormats());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const body = await req.json();
          db.saveCustomFormat(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    // ---- Shows ---------------------------------------------------------

    "/api/shows": {
      async GET() {
        try {
          const shows = db.listShows();
          return json(
            shows.map((s: any) => ({
              id: s.id,
              providerType: s.provider_type,
              title: s.title,
              profile: s.profile,
              uuid: s.id,
              rootFolderPath: s.root_folder_path,
              lastUpdated: s.last_updated,
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req) {
        try {
          const body = (await req.json()) as { source: string; providerId: string; name?: string; rootFolderPath?: string };
          if (!body?.source || !body?.providerId) {
            return errorResponse("Both `source` and `providerId` are required.");
          }
          if (!isProviderType(body.source)) {
            return errorResponse(`Unknown source "${body.source}". Must be one of: tmdb, tvdb, anilist.`);
          }

          // Check if this provider+ID is already linked to a show
          const existing = db.getShowByProvider(body.source, body.providerId);
          if (existing) {
            return json({
              id: existing.id,
              title: existing.title,
              providerType: body.source,
              message: 'Show already in library',
            }, { status: 200 });
          }

          const config = loadConfig();
          const provider = ProviderFactory.getProvider(body.source, config);

          let title = body.name;
          if (!title) {
            const showData = await provider.getShow(body.providerId);
            title = showData.title;
          }

          const showUuid = crypto.randomUUID();
          db.saveShow({
            uuid: showUuid,
            providerId: body.providerId,
            type: body.source,
            title,
            config: {
              metadataProvider: body.source,
              airtimeProvider: body.source,
            },
            rootFolderPath: body.rootFolderPath,
          });

          // Full sync (metadata + episodes + air dates) so the show isn't
          // empty the moment it shows up in the library grid. Delegates to
          // SyncManager so the add-flow and scheduled sync never drift apart.
          // We run this in the background to avoid freezing the UI.
          new SyncManager(config).syncShow(showUuid).catch(syncErr => {
            console.warn(`[api] initial sync failed for "${title}":`, syncErr);
          });

          return json({ id: showUuid, providerType: body.source, title }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id": {
      async GET(req) {
        try {
          const show = db.getShow(req.params.id);
          if (!show) return errorResponse("Show not found.", 404);

          const config = db.getShowConfig(req.params.id);

          return json({
            id: show.id,
            providerType: show.provider_type,
            title: show.title,
            profile: show.profile,
            year: show.year,
            originalTitle: show.original_title,
            rootFolderPath: show.root_folder_path,
            lastUpdated: show.last_updated,
            config,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async PATCH(req) {
        try {
          const body = (await req.json()) as { profile?: string; title?: string; rootFolderPath?: string; config?: Record<string, any> };
          db.updateShow(req.params.id, body);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req) {
        try {
          db.removeShow(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // ---- Seasons / Episodes ---------------------------------------------
    // There's no populated `seasons` table yet (nothing calls db.saveSeason
    // in the current backend), so seasons are derived here from the
    // episodes table, which sync/add does populate.

    "/api/shows/:id/seasons": {
      async GET(req) {
        try {
          const episodes = db.listAllEpisodes(req.params.id);
          const bySeason = new Map<number, { episodeCount: number; trackedCount: number }>();
          for (const ep of episodes) {
            const entry = bySeason.get(ep.season_number) ?? { episodeCount: 0, trackedCount: 0 };
            entry.episodeCount += 1;
            if (ep.is_tracked) entry.trackedCount += 1;
            bySeason.set(ep.season_number, entry);
          }
          const seasons = [...bySeason.entries()]
            .sort(([a], [b]) => {
              if (a === 0) return 1;
              if (b === 0) return -1;
              return a - b;
            })
            .map(([seasonNumber, stats]) => ({ seasonNumber, ...stats }));
          return json(seasons);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes": {
      async GET(req) {
        try {
          const seasonNumber = parseInt(req.params.season, 10);
          const episodes = db.listEpisodes(req.params.id, seasonNumber);
          return json(
            episodes.map((e: any) => ({
              season: e.season_number,
              episode: e.episode_number,
              absoluteNumber: e.absolute_number,
              title: e.title,
              filePath: e.file_path,
              tracked: !!e.is_tracked,
              airDate: e.air_date || null,
              searchMode: e.search_mode || 'auto',
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/grab": {
      async POST(req) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season, 10);
          const episode = parseInt(req.params.episode, 10);
          const result = await grabber.grabBestRelease(req.params.id, season, episode);
          return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Auto-grabs the single best release for an entire season (season packs
    // included), scored against the show's assigned quality profile.
    "/api/shows/:id/seasons/:season/grab": {
      async POST(req) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season, 10);
          const result = await grabber.grabBestSeasonRelease(req.params.id, season);
          return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Interactive search: returns every scored release found for a season
    // (packs and individual episodes both come back from Prowlarr for a
    // season-level query), letting the person pick exactly which one to grab
    // via POST /api/search/grab.
    "/api/shows/:id/seasons/:season/search": {
      async GET(req) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season, 10);
          const result = await grabber.searchReleases(req.params.id, season);
          if ("error" in result) return errorResponse(result.error, 400);
          return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    // ---- Indexer management / search ---------------------------------------

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

    "/api/search": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const query = url.searchParams.get("q");
          if (!query || query.trim().length === 0) return json([]);

          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const categories = url.searchParams.getAll("category").map(c => parseInt(c, 10)).filter(c => !Number.isNaN(c));
          const type = (url.searchParams.get("type") as "search" | "tvsearch" | "movie" | "music" | "book" | null) ?? undefined;

          const indexer = getProwlarrIndexer();
          if (!indexer) return json({ error: "Prowlarr not configured" }, { status: 400 });

          const results = await indexer.search(query, { categories: categories.length ? categories : undefined, type });
          const sliced = results.slice(0, Number.isNaN(limit) ? 50 : limit);
          return json(sliced);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    // Grabs a specific release the person picked from `/api/search` results
    // (interactive search), as opposed to GrabberService's fully-automatic
    // "find and grab the best one" flow used by the per-episode grab route.
    "/api/search/grab": {
      async POST(req) {
        try {
          const release = await req.json();
          if (!release?.guid || !release?.indexerId) {
            return errorResponse("A full release object (as returned by /api/search) is required.");
          }
          const indexer = getProwlarrIndexer();
          if (!indexer) return json({ error: "Prowlarr not configured" }, { status: 400 });

          const ok = await indexer.grab(release);
          if (ok) {
            db.logEvent({ type: "grab", entityType: "release", message: `Grabbed ${release.title}` });
          }
          return json({ success: ok, message: ok ? `Grabbed ${release.title}` : `Grab failed for "${release.title}". Check that a Download Client is configured in Prowlarr.` });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/shows/:id/sync": {
      async POST(req) {
        try {
          const show = db.getShow(req.params.id);
          if (!show) return errorResponse("Show not found.", 404);
          await new SyncManager(loadConfig()).syncShow(req.params.id);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // ---- Provider management ----------------------------------------------

    "/api/shows/:id/providers": {
      async GET(req) {
        try {
          const providers = db.listShowProvidersWithRoles(req.params.id);
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
      async POST(req) {
        try {
          const { providerType, providerId } = await req.json();
          if (!providerType || !providerId) {
            return errorResponse("providerType and providerId are required");
          }
          db.addShowProvider(req.params.id, providerType, providerId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type": {
      async DELETE(req) {
        try {
          db.removeShowProvider(req.params.id, req.params.type);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type/primary": {
      async PUT(req) {
        try {
          db.setPrimaryProvider(req.params.id, req.params.type);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/providers/:type/role": {
      async PUT(req) {
        try {
          const { role, active } = await req.json();
          if (!role || !['metadata', 'airtime'].includes(role)) {
            return errorResponse("role must be 'metadata' or 'airtime'");
          }
          db.setProviderRole(req.params.id, req.params.type, role as 'metadata' | 'airtime', !!active);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/seasons/:season/tracked": {
      async PATCH(req) {
        try {
          const body = (await req.json()) as { tracked: boolean };
          const showId = req.params.id;
          const seasonNumber = parseInt(req.params.season, 10);
          const episodes = db.listEpisodes(showId, seasonNumber);
          episodes.forEach(e => db.setTracked(showId, e.season_number, e.episode_number, !!body.tracked));
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/tracked": {
      async PATCH(req) {
        try {
          const { tracked } = await req.json();
          db.setTracked(req.params.id, parseInt(req.params.season, 10), parseInt(req.params.episode, 10), !!tracked);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/search": {
      // Interactive search: returns every scored release found for this
      // specific episode, letting the person pick which one to grab via
      // POST /api/search/grab.
      async GET(req) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season, 10);
          const episode = parseInt(req.params.episode, 10);
          const result = await grabber.searchReleases(req.params.id, season, episode);
          if ("error" in result) return errorResponse(result.error, 400);
          return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
      async PATCH(req) {
        try {
          const { mode } = await req.json();
          if (mode !== 'auto' && mode !== 'interactive') return errorResponse("mode must be 'auto' or 'interactive'");
          db.updateEpisodeSearchMode(req.params.id, parseInt(req.params.season, 10), parseInt(req.params.episode, 10), mode);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    // ---- Providers (search, for the Add Show flow) -----------------------

    "/api/providers/:source/search": {
      async GET(req) {
        try {
          const source = req.params.source;
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
              // Extract alternate titles from provider metadata if not already mapped
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

    // ---- Show UUID image proxy --------------------------------------------

    "/api/shows/:id/images/poster": {
      async GET(req) {
        try {
          const show = db.getShow(req.params.id);
          if (!show) return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
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

          return new Response(imgRes.body, {
            headers: {
              "Content-Type": imgRes.headers.get("Content-Type") ?? "image/jpeg",
              "Cache-Control": "public, max-age=21600",
            },
          });
        } catch (err) {
          console.warn(`[api] poster fetch failed for show ${req.params.id}:`, err);
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
      },
    },

    "/api/shows/:id/images/backdrop": {
      async GET(req) {
        try {
          const show = db.getShow(req.params.id);
          if (!show) return new Response('', { status: 404 });
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(show.provider_type, config);

          let backdropUrl: string | null = null;

          if (show.provider_type === "tvdb") {
            const tvdb = provider as TVDBProvider;
            for (const artType of [3, 15]) {
              const artworks = await tvdb.getSeriesArtworks(show.provider_id, artType);
              const art = artworks[0];
              if (art?.image) {
                backdropUrl = art.image;
                db.saveShowArtwork(show.id, artType, art.image, art.width, art.height, art.thumbnail);
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
          return new Response(imgRes.body, {
            headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=21600" },
          });
        } catch {
          return new Response('', { status: 404 });
        }
      },
    },

    // ---- Poster proxy -----------------------------------------------------
    // Keeps provider API keys server-side and sidesteps CORS. Relies on
    // BaseProvider's own metadata_cache (6h TTL) so repeated grid renders
    // don't hammer the upstream API.

    "/api/images/poster/:source/:id": {
      async GET(req) {
        const source = req.params.source;
        if (!isProviderType(source)) {
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);
          const show = await provider.getShow(req.params.id);
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
              "Cache-Control": "public, max-age=21600", // 6h, matches metadata_cache TTL
            },
          });
        } catch (err) {
          console.warn(`[api] poster fetch failed for ${source}/${req.params.id}:`, err);
          return new Response(NO_SIGNAL_SVG, { headers: { "Content-Type": "image/svg+xml" } });
        }
      },
    },

    "/api/images/backdrop/:source/:id": {
      async GET(req) {
        const source = req.params.source;
        if (!isProviderType(source)) {
          return new Response('', { status: 404 });
        }
        const showId = req.params.id;
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);

          let backdropUrl: string | null = null;

          // For TVDB, try the artworks API for widescreen backgrounds (type 3 or 15)
          if (source === "tvdb") {
            const tvdb = provider as TVDBProvider;
            for (const artType of [3, 15]) {
              const artworks = await tvdb.getSeriesArtworks(showId, artType);
              const art = artworks[0];
              if (art?.image) {
                backdropUrl = art.image;
                db.saveShowArtwork(showId, artType, art.image, art.width, art.height, art.thumbnail);
                break;
              }
            }
          }

          // Fallback to metadata-based extraction for all providers
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

    // ---- Artwork proxy (TVDB artwork types) --------------------------------
    // Fetches provider-specific artwork (banner, fanart, poster) by type ID,
    // caches the metadata in the DB and the image bytes on disk.

    "/api/images/artwork/:source/:id/:type": {
      async GET(req) {
        const source = req.params.source;
        if (!isProviderType(source)) {
          return new Response('', { status: 404 });
        }
        const type = parseInt(req.params.type, 10);
        if (Number.isNaN(type)) {
          return new Response('', { status: 400 });
        }

        const showId = req.params.id;
        try {
          const config = loadConfig();
          const provider = ProviderFactory.getProvider(source, config);

          // Check DB for cached artwork data
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

          // Try provider-specific artwork endpoint first
          if (source === "tvdb") {
            const tvdb = provider as TVDBProvider;
            let artworks = existing;
            if (artworks.length === 0) {
              try {
                const seriesArtworks = await tvdb.getSeriesArtworks(showId, type);
                for (const art of seriesArtworks) {
                  db.saveShowArtwork(showId, art.type, art.image, art.width, art.height, art.thumbnail);
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

          // Fallback: extract backdrop/poster from show metadata (works for all providers)
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

    // ---- Calendar -----------------------------------------------------------
    // Reads straight from the synced episodes table (air_date, populated by
    // SyncManager) - no live provider calls on this path.

    "/api/calendar": {
      async GET(req) {
        try {
          const url = new URL(req.url);
          const days = parseInt(url.searchParams.get("days") ?? "7", 10);
          const past = parseInt(url.searchParams.get("past") ?? "0", 10);
          const episodes = db.listUpcomingEpisodes(Number.isNaN(days) ? 7 : days, Number.isNaN(past) ? 0 : past);
          return json(
              episodes.map((ep: any) => ({
              showId: ep.show_id,
              showTitle: ep.show_title,
              episodeTitle: ep.title,
              season: ep.season_number,
              episode: ep.episode_number,
              airDate: ep.air_date,
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

const config = loadConfig();
const scheduler = new Scheduler(config);
scheduler.start();

const systemManager = new SystemManager(config);

console.log(`🚀 Server running at ${server.url}`);
