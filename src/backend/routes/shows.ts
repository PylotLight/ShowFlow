import { db } from "../db";
import * as schema from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { ProviderFactory } from "../providers/factory";
import { SyncManager } from "../core/sync_manager";
import { GrabberService } from "../core/grabber_service";
import type { Scheduler } from "../core/scheduler";
import type { SystemManager } from "../core/system_manager";
import path from "node:path";
import fs from "node:fs";
import type { RouteReq } from "./_shared";
import { json, errorResponse, loadConfig, isProviderType, serializeRelease, toIsoUtc } from "./_shared";

export function showRoutes(scheduler: Scheduler, systemManager: SystemManager) {
  return {

    "/api/shows": {
      async GET() {
        try {
          const shows = db.listShows();
          const showIds = shows.map((s: any) => s.id);

          const episodeStats = showIds.length > 0
            ? db.drizz.select({
                show_id: schema.episodes.show_id,
                is_tracked: schema.episodes.is_tracked,
                file_path: schema.episodes.file_path,
              })
              .from(schema.episodes)
              .where(inArray(schema.episodes.show_id, showIds))
              .all() as { show_id: string; is_tracked: number; file_path: string | null }[]
            : [];

          const statsMap = new Map<string, { tracked_count: number; grabbed_count: number }>();
          episodeStats.forEach(ep => {
            const existing = statsMap.get(ep.show_id) || { tracked_count: 0, grabbed_count: 0 };
            if (ep.is_tracked === 1) existing.tracked_count++;
            if (ep.file_path) existing.grabbed_count++;
            statsMap.set(ep.show_id, existing);
          });

          return json(
            shows.map((s: any) => {
              const stats = statsMap.get(s.id) || { tracked_count: 0, grabbed_count: 0 };
              return {
                id: s.id,
                providerType: s.provider_type,
                title: s.title,
                profile: s.profile,
                seriesType: s.series_type,
                uuid: s.id,
                rootFolderPath: s.root_folder_path,
                lastUpdated: s.last_updated,
                addedAt: s.added_at,
                trackedCount: stats.tracked_count,
                grabbedCount: stats.grabbed_count,
              };
            }),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: RouteReq) {
        try {
          const body = (await req.json()) as { source: string; providerId: string; name?: string; rootFolderPath?: string; profile?: string; showProfileId?: string; seriesType?: string };
          if (!body?.source || !body?.providerId) {
            return errorResponse("Both `source` and `providerId` are required.");
          }
          if (!isProviderType(body.source)) {
            return errorResponse(`Unknown source "${body.source}". Must be one of: tmdb, tvdb, anilist.`);
          }

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

          const showData = await provider.getShow(body.providerId);
          const providerId = showData.id;
          const title = body.name?.trim() || showData.title;

          const showUuid = crypto.randomUUID();
          const seriesType = body.seriesType || 'standard';

          if (!body.showProfileId && !body.rootFolderPath) {
            const showProfiles = db.listShowProfiles();
            if (showProfiles.length > 0) {
              body.showProfileId = showProfiles[0]?.id;
            }
          }

          db.saveShow({
            uuid: showUuid,
            providerId: body.providerId,
            type: body.source,
            title,
            originalTitle: showData.originalTitle,
            romanizedTitle: showData.romanizedTitle,
            metadata: showData.metadata,
            profile: body.profile,
            showProfileId: body.showProfileId,
            seriesType,
            config: {},
            rootFolderPath: body.rootFolderPath,
          });

          new SyncManager(config).syncShow(showUuid).catch(syncErr => {
            console.warn(`[api] initial sync failed for "${title}":`, syncErr);
          });

          return json({ id: showUuid, providerType: body.source, title }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/bulk-delete": {
      async POST(req: RouteReq) {
        try {
          const { ids } = await req.json() as { ids: string[] };
          if (!Array.isArray(ids) || ids.length === 0) {
            return errorResponse("ids array is required.");
          }
          for (const id of ids) {
            const show = db.getShow(id);
            if (show) {
              db.logEvent({
                type: 'delete',
                entityType: 'show',
                entityId: id,
                message: `Removed show "${show.title}"`,
              });
            }
          }
          db.removeShows(ids);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id": {
      async GET(req: RouteReq) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return errorResponse("Show not found.", 404);

          const config = db.getShowConfig(req.params.id!);

          return json({
            id: show.id,
            providerType: show.provider_type,
            title: show.title,
            profile: show.profile,
            year: show.year,
            originalTitle: show.original_title,
            rootFolderPath: show.root_folder_path,
            seriesType: show.series_type ?? 'standard',
            lastUpdated: show.last_updated,
            config,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async PATCH(req: RouteReq) {
        try {
          const body = (await req.json()) as { profile?: string; title?: string; rootFolderPath?: string; seriesType?: string; config?: Record<string, any> };
          db.updateShow(req.params.id!, body);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req: RouteReq) {
        try {
          const show = db.getShow(req.params.id!);
          db.removeShow(req.params.id!);
          db.logEvent({
            type: 'delete',
            entityType: 'show',
            entityId: req.params.id!,
            message: `Removed show "${show?.title ?? 'unknown'}"`,
          });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/relocate": {
      async POST(req: RouteReq) {
        try {
          const { newRootPath } = await req.json() as { newRootPath: string };
          const showId = req.params.id!;
          const show = db.getShow(showId);
          if (!show) return errorResponse("Show not found", 404);
          const oldRoot = show.rootFolderPath;
          if (!oldRoot) return errorResponse("Show has no root folder set", 400);

          const episodes = db.listShowEpisodes(showId);
          const results: { season: number; episode: number; ok: boolean; error?: string }[] = [];

          for (const ep of episodes) {
            if (!ep.file_path) continue;
            const relative = ep.file_path.startsWith(oldRoot)
              ? ep.file_path.slice(oldRoot.length).replace(/^\//, '')
              : path.basename(ep.file_path);
            const newPath = path.posix ? path.posix.join(newRootPath, relative) : path.join(newRootPath, relative);

            const dir = path.dirname(newPath);
            await fs.promises.mkdir(dir, { recursive: true });

            try {
              await fs.promises.rename(ep.file_path, newPath);
            } catch (err: any) {
              if (err.code === 'EXDEV') {
                await fs.promises.copyFile(ep.file_path, newPath);
                await fs.promises.unlink(ep.file_path);
              } else {
                results.push({ season: ep.season_number, episode: ep.episode_number, ok: false, error: err.message });
                continue;
              }
            }
            db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, newPath);
            results.push({ season: ep.season_number, episode: ep.episode_number, ok: true });
          }

          return json({ ok: true, moved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/organize": {
      async POST(req: RouteReq) {
        try {
          const showId = req.params.id!;
          const show = db.getShow(showId);
          if (!show) return errorResponse("Show not found", 404);

          const episodes = db.listShowEpisodes(showId);
          const results: { season: number; episode: number; ok: boolean; skipped?: boolean; error?: string }[] = [];

          for (const ep of episodes) {
            if (!ep.file_path) continue;
            const ext = path.extname(ep.file_path);
            const dir = path.dirname(ep.file_path);
            const newName = `${show.title} - S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}${ext}`;
            const newPath = path.join(dir, newName);

            if (newPath === ep.file_path) {
              results.push({ season: ep.season_number, episode: ep.episode_number, ok: true, skipped: true });
              continue;
            }

            try {
              await fs.promises.rename(ep.file_path, newPath);
              db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, newPath);
              results.push({ season: ep.season_number, episode: ep.episode_number, ok: true });
            } catch (err: any) {
              results.push({ season: ep.season_number, episode: ep.episode_number, ok: false, error: err.message });
            }
          }

          return json({ ok: true, renamed: results.filter(r => r.ok && !r.skipped).length, skipped: results.filter(r => r.skipped).length, failed: results.filter(r => !r.ok).length, results });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/sync": {
      async POST(req: RouteReq) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return errorResponse("Show not found.", 404);
          await new SyncManager(loadConfig()).syncShow(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/sync-all": {
      async POST(req: RouteReq) {
        try {
          const body = await req.json().catch(() => ({})) as { force?: boolean };
          const syncManager = new SyncManager(loadConfig());
          const result = await syncManager.syncAllShows(body.force ?? true);
          return json({ ok: true, ...result });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/scan": {
      async POST(req: RouteReq) {
        try {
          const show = db.getShow(req.params.id!);
          if (!show) return errorResponse("Show not found.", 404);
          await systemManager.scanShow(req.params.id!);
          db.logEvent({
            type: 'scan',
            entityType: 'show',
            entityId: req.params.id!,
            message: `Scanned show "${show.title}"`,
          });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons": {
      async GET(req: RouteReq) {
        try {
          const episodes = db.listAllEpisodes(req.params.id!);
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
      async GET(req: RouteReq) {
        try {
          const seasonNumber = parseInt(req.params.season!, 10);
          const episodes = db.listEpisodes(req.params.id!, seasonNumber);
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
      async POST(req: RouteReq) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season!, 10);
          const episode = parseInt(req.params.episode!, 10);
          const result = await grabber.grabBestRelease(req.params.id!, season, episode);
          return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/grab": {
      async POST(req: RouteReq) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season!, 10);
          const result = await grabber.grabBestSeasonRelease(req.params.id!, season);
          return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/search": {
      async GET(req: RouteReq) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season!, 10);
          const result = await grabber.searchReleases(req.params.id!, season);
          if ("error" in result) return errorResponse(result.error, 400);
          return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/shows/:id/seasons/:season/tracked": {
      async PATCH(req: RouteReq) {
        try {
          const body = (await req.json()) as { tracked: boolean };
          const showId = req.params.id!;
          const seasonNumber = parseInt(req.params.season!, 10);
          const episodes = db.listEpisodes(showId, seasonNumber);
          episodes.forEach(e => db.setTracked(showId, e.season_number, e.episode_number, !!body.tracked));
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/tracked": {
      async PATCH(req: RouteReq) {
        try {
          const { tracked } = await req.json();
          db.setTracked(req.params.id!, parseInt(req.params.season!, 10), parseInt(req.params.episode!, 10), !!tracked);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/search": {
      async GET(req: RouteReq) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config);
          const season = parseInt(req.params.season!, 10);
          const episode = parseInt(req.params.episode!, 10);
          const result = await grabber.searchReleases(req.params.id!, season, episode);
          if ("error" in result) return errorResponse(result.error, 400);
          return json({ profileId: result.profileId, releases: result.releases.map(serializeRelease) });
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
      async PATCH(req: RouteReq) {
        try {
          const { mode } = await req.json();
          if (mode !== 'auto' && mode !== 'interactive') return errorResponse("mode must be 'auto' or 'interactive'");
          db.updateEpisodeSearchMode(req.params.id!, parseInt(req.params.season!, 10), parseInt(req.params.episode!, 10), mode);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/calendar": {
      async GET(req: RouteReq) {
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
              filePath: ep.file_path ?? null,
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/missing": {
      async GET() {
        try {
          const episodes = db.listMissingEpisodes();
          return json(
            episodes.map((ep: any) => ({
              showId: ep.show_id,
              showTitle: ep.show_title,
              episodeTitle: ep.title,
              season: ep.season_number,
              episode: ep.episode_number,
              airDate: ep.air_date,
              searchMode: ep.search_mode || 'auto',
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/events": {
      async GET(req: RouteReq) {
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
              timestamp: toIsoUtc(e.timestamp),
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
