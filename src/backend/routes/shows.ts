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
import { describeReasonCode } from "../core/pipeline/reason_codes";
import { cleanReleaseName } from "../parser";

/**
 * Resolve the show's own folder on disk so a folder-rename targets the right
 * directory. A show's `root_folder_path` is the *library* root (e.g.
 * /volumes/Media/Anime) shared by every show in that profile — NOT the
 * per-show folder. The show's files live one level below it as a direct child
 * named after the title (the layout the blackhole client and library scanner
 * produce: <root>/<Title>/Season XX/...). Renaming the library root itself
 * would move every other show in the profile; that was the pre-fix behavior.
 */
function resolveShowFolder(show: any, rootFolder: string, episodes: any[]) {
  const sanitizedTitle = (show.title || '')
    .replace(/[<>"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // The current folder name is whatever direct child of the library root
  // actually holds this show's files. Derive it from episode paths when
  // available (all episode paths for one show share a single child dir);
  // fall back to the sanitized title when nothing is on disk yet — in that
  // case there is nothing to rename and wouldChange reads false.
  const childNames = new Set<string>();
  for (const ep of episodes) {
    if (!ep.file_path) continue;
    if (!ep.file_path.startsWith(rootFolder)) continue;
    const rel = ep.file_path.slice(rootFolder.length).replace(/^[/\\]+/, '');
    const first = rel.split(/[/\\]/)[0];
    if (first) childNames.add(first);
  }

  let currentFolderName: string;
  if (childNames.size === 1) {
    currentFolderName = [...childNames][0]!;
  } else {
    currentFolderName = sanitizedTitle;
  }

  const currentFolderPath = path.join(rootFolder, currentFolderName);
  const targetFolderPath = path.join(rootFolder, sanitizedTitle);
  const wouldChange = currentFolderPath !== targetFolderPath;

  return { currentFolderPath, currentFolderName, sanitizedTitle, targetFolderPath, wouldChange };
}

// Format the media columns as a compact frontend-usable object, or null
// when the file hasn't been probed yet.
function serializeFileMedia(f: any) {
  return {
    container: f.container ?? null,
    videoWidth: f.video_width ?? null,
    videoHeight: f.video_height ?? null,
    videoCodec: f.video_codec ?? null,
    videoFps: f.video_fps ?? null,
    hdr: !!f.hdr,
    audioCodec: f.audio_codec ?? null,
    audioChannels: f.audio_channels ?? null,
    durationSeconds: f.duration_seconds ?? null,
    bitrateKbps: f.bitrate_kbps ?? null,
    probedAt: f.probed_at ?? null,
  };
}

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
          const body = (await req.json()) as { source: string; providerId: string; name?: string; rootFolderPath?: string; profile?: string; showProfileId?: string; seriesType?: string; libraryTypeId?: string };
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
          if (!provider.isConfigured()) {
            return errorResponse(`Source "${body.source}" is not configured.`, 400);
          }

          const showData = await provider.getShow(body.providerId);
          const providerId = showData.id;
          const title = body.name?.trim() || showData.title;

          const showUuid = crypto.randomUUID();
          const seriesType = body.seriesType || 'standard';

          // When libraryTypeId is set, resolve root folder and quality profile
          // from the library type (design-brief-platform-ux-systems.md §1).
          if (body.libraryTypeId) {
            const resolvedId = db.resolveLibraryTypeId(body.libraryTypeId);
            const libraryType = resolvedId ? db.getLibraryType(resolvedId) : null;
            if (libraryType) {
              body.rootFolderPath ??= libraryType.root_folder_path ?? undefined;
              body.profile ??= libraryType.quality_profile_id ?? undefined;
            }
          }

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
            libraryTypeId: body.libraryTypeId,
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

    "/api/shows/bulk-update": {
      async POST(req: RouteReq) {
        try {
          const body = await req.json() as {
            ids?: string[];
            profile?: string;
            seriesType?: string;
            libraryTypeId?: string;
            tracked?: boolean;
          };
          const ids = Array.isArray(body?.ids) ? body.ids : [];
          if (ids.length === 0) {
            return errorResponse("ids array is required.");
          }
          const hasChanges =
            body.profile !== undefined ||
            body.seriesType !== undefined ||
            body.libraryTypeId !== undefined ||
            body.tracked !== undefined;
          if (!hasChanges) {
            return errorResponse("Nothing to update - provide profile, seriesType, libraryTypeId, or tracked.");
          }
          if (body.seriesType !== undefined && !['standard', 'anime'].includes(body.seriesType)) {
            return errorResponse("seriesType must be 'standard' or 'anime'.");
          }

          const updatedIds = db.bulkUpdateShows(ids, {
            profile: body.profile,
            seriesType: body.seriesType,
            libraryTypeId: body.libraryTypeId,
            tracked: body.tracked,
          });

          const parts: string[] = [];
          if (body.libraryTypeId !== undefined) parts.push("library type");
          if (body.profile !== undefined) parts.push("quality profile");
          if (body.seriesType !== undefined) parts.push("series type");
          if (body.tracked !== undefined) parts.push(`tracking (${body.tracked ? 'tracked' : 'untracked'})`);
          db.logEvent({
            type: 'bulk-update',
            entityType: 'show',
            entityId: ids.join(','),
            message: `Bulk updated ${updatedIds.length} show${updatedIds.length !== 1 ? "s" : ""}: ${parts.join(", ")}`,
          });

          return json({ ok: true, updated: updatedIds.length });
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
            // Learned release delay forecast (minutes after air). Used by the
            // UI to show the show's expected release window alongside air
            // dates.
            releaseDelayMinutes: show.release_delay_minutes,
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

    // Rename the show's folder on disk to match its sanitized title.
    // NOTE: a show's `root_folder_path` is the *library* root (e.g.
    // /volumes/Media/Anime) shared by every show in that profile — NOT the
    // per-show folder. The show's own folder lives one level below it as a
    // direct child named after the title (the same layout the blackhole
    // client and library scanner produce: <root>/<Title>/Season XX/...).

    "/api/shows/:id/rename-preview": {
      async GET(req: RouteReq) {
        try {
          const showId = req.params.id!;
          const show = db.getShow(showId);
          if (!show) return errorResponse("Show not found", 404);
          const rootFolder = db.getShowRootFolder(showId);
          if (!rootFolder) return errorResponse("Show has no root folder set", 400);

          const episodes = db.listShowEpisodes(showId);
          const { currentFolderPath, currentFolderName, sanitizedTitle, targetFolderPath, wouldChange } =
            resolveShowFolder(show, rootFolder, episodes);

          // Surface which episodes sit inside the current show folder — those
          // rows get their file paths rewritten if the rename proceeds.
          const episodeImpact = episodes
            .filter((e) => e.file_path)
            .map((e) => {
              const inTarget = e.file_path!.startsWith(currentFolderPath);
              return {
                season: e.season_number,
                episode: e.episode_number,
                currentPath: e.file_path,
                wouldUpdate: inTarget && wouldChange,
              };
            });

          return json({
            showId,
            libraryRoot: rootFolder,
            currentFolderPath,
            currentFolderName,
            sanitizedTitle,
            targetFolderPath,
            wouldChange,
            episodeImpact,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/rename-apply": {
      async POST(req: RouteReq) {
        try {
          const showId = req.params.id!;
          const show = db.getShow(showId);
          if (!show) return errorResponse("Show not found", 404);
          const rootFolder = db.getShowRootFolder(showId);
          if (!rootFolder) return errorResponse("Show has no root folder set", 400);

          const episodes = db.listShowEpisodes(showId);
          const { currentFolderPath, sanitizedTitle, targetFolderPath, wouldChange } =
            resolveShowFolder(show, rootFolder, episodes);

          if (!wouldChange) {
            return json({ ok: true, renamed: false, message: 'Folder already has the target name.' });
          }

          if (!fs.existsSync(currentFolderPath)) {
            return errorResponse(`Source folder does not exist: ${currentFolderPath}`, 400);
          }
          if (fs.existsSync(targetFolderPath)) {
            return errorResponse(`Target folder already exists: ${targetFolderPath}. Refusing to overwrite.`, 409);
          }

          // Rename the directory, then rewrite every episode row that pointed
          // inside the old folder. We update the DB BEFORE the FS rename so a
          // crash mid-batch leaves the DB pointing at paths that don't exist
          // yet (recoverable by re-running) rather than paths that no longer
          // exist (data loss).
          const pathUpdates: { season: number; episode: number; oldPath: string; newPath: string }[] = [];
          for (const ep of episodes) {
            if (!ep.file_path) continue;
            if (!ep.file_path.startsWith(currentFolderPath)) continue;
            const relative = ep.file_path.slice(currentFolderPath.length).replace(/^[/\\]/, '');
            pathUpdates.push({
              season: ep.season_number,
              episode: ep.episode_number,
              oldPath: ep.file_path,
              newPath: path.join(targetFolderPath, relative),
            });
          }

          await fs.promises.rename(currentFolderPath, targetFolderPath);
          for (const u of pathUpdates) {
            db.updateEpisodeFilePath(showId, u.season, u.episode, u.newPath);
          }

          db.logEvent({
            type: 'organize',
            entityType: 'show',
            entityId: showId,
            message: `Renamed show folder "${currentFolderPath}" → "${targetFolderPath}" (${pathUpdates.length} episode paths updated)`,
          });

          return json({
            ok: true,
            renamed: true,
            from: currentFolderPath,
            to: targetFolderPath,
            episodesUpdated: pathUpdates.length,
          });
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

          if (show) {
            const renamedCount = results.filter(r => r.ok && !r.skipped).length;
            const skippedCount = results.filter(r => r.skipped).length;
            const failedCount = results.filter(r => !r.ok).length;
            db.logEvent({ type: 'organize', entityType: 'show', entityId: showId, message: `Organized "${show.title}": ${renamedCount} renamed, ${skippedCount} skipped, ${failedCount} failed` });
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

    // ---- Episode mapping (anime season-splits, issues-tracking.md #4) ----

    "/api/shows/:id/episode-mapping": {
      async GET(req: RouteReq) {
        try {
          if (!db.getShow(req.params.id!)) return errorResponse("Show not found.", 404);
          const { summarizeSync: summarizeSyncDynamic } = await import("../core/episode_mappings");
          return json(summarizeSyncDynamic(db, req.params.id!));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: RouteReq) {
        try {
          if (!db.getShow(req.params.id!)) return errorResponse("Show not found.", 404);
          const body = (await req.json()) as { enabled?: boolean | number; source?: string };
          if (body.enabled !== undefined) {
            db.setEpisodeMappingConfig(req.params.id!, { enabled: !!body.enabled });
          }
          if (body.source !== undefined && ['thexem', 'anidb', 'manual'].includes(body.source)) {
            db.setEpisodeMappingConfig(req.params.id!, { source: body.source });
          }
          const { summarizeSync: summarizeSyncDynamic } = await import("../core/episode_mappings");
          return json(summarizeSyncDynamic(db, req.params.id!));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/episode-mapping/refresh": {
      async POST(req: RouteReq) {
        try {
          if (!db.getShow(req.params.id!)) return errorResponse("Show not found.", 404);
          const { EpisodeMappingService } = await import("../core/episode_mappings");
          const summary = await new EpisodeMappingService().syncShow(req.params.id!, { refreshTTL: true });
          return json({ ok: true, ...summary });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/episode-mapping/rows/:rowId": {
      async PATCH(req: RouteReq) {
        try {
          if (!db.getShow(req.params.id!)) return errorResponse("Show not found.", 404);
          const body = (await req.json()) as { targetSeason?: number; targetEpisode?: number; targetAbsolute?: number | null; locked?: boolean };
          const rowId = parseInt(req.params.rowId!, 10);
          if (!Number.isFinite(rowId)) return errorResponse("Invalid row id.", 400);
          const row = db.listEpisodeMappings(req.params.id!).find(r => r.id === rowId);
          if (!row) return errorResponse("Mapping row not found.", 404);
          const targetSeason = body.targetSeason ?? row.target_season ?? null;
          const targetEpisode = body.targetEpisode ?? row.target_episode ?? null;
          if (targetSeason === null || targetEpisode === null) {
            return errorResponse("Target season and episode are required to fix a mapping row.", 400);
          }
          const ok = db.lockMappingRow(req.params.id!, rowId, {
            target_season: targetSeason,
            target_episode: targetEpisode,
            target_absolute: body.targetAbsolute !== undefined ? body.targetAbsolute ?? undefined : (row.target_absolute ?? undefined),
          });
          if (!ok) return errorResponse("Mapping row update failed.", 500);
          db.logEvent({
            type: 'mapping',
            entityType: 'episode',
            entityId: String(rowId),
            message: `Manual mapping fix: scene S${row.scene_season}E${row.scene_episode} -> provider S${targetSeason}E${targetEpisode} (locked)`,
          });
          const { summarizeSync: summarizeSyncDynamic } = await import("../core/episode_mappings");
          return json({ ok: true, ...summarizeSyncDynamic(db, req.params.id!) });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Lock every unlocked mapping row in one call. Scene numbering is kept;
    // each row's provider S/E is derived by adding a per-season offset to the
    // scene S/E. The user's complaint driving this: after fixing S01E01, they
    // still had to click Fix on every other episode even though the whole
    // season shares the same scene->provider shift.
    "/api/shows/:id/episode-mapping/rows-bulk": {
      async POST(req: RouteReq) {
        try {
          if (!db.getShow(req.params.id!)) return errorResponse("Show not found.", 404);
          const body = (await req.json()) as {
            // Lock these rows only. Default: every unlocked row.
            rowIds?: number[];
            // Coarsest option: provider = scene + this constant (default 0 season, 0 episode).
            seasonOffset?: number;
            episodeOffset?: number;
            // Per-row explicit targets override the offset for that row.
            targets?: { rowId: number; targetSeason: number; targetEpisode: number }[];
          } | null;

          const rows = db.listEpisodeMappings(req.params.id!);
          if (rows.length === 0) return errorResponse("No mapping rows to fix.", 400);

          const targetMap = new Map<number, { targetSeason: number; targetEpisode: number }>();
          for (const t of body?.targets ?? []) {
            if (!Number.isFinite(t.rowId)) continue;
            if (!Number.isFinite(t.targetSeason) || !Number.isFinite(t.targetEpisode)) continue;
            targetMap.set(t.rowId, { targetSeason: t.targetSeason, targetEpisode: t.targetEpisode });
          }

          const wanted: Set<number> | null = Array.isArray(body?.rowIds) && body.rowIds.length > 0
            ? new Set(body.rowIds.filter(n => Number.isFinite(n)))
            : null;

          const seasonOffset = Number.isFinite(body?.seasonOffset) ? body!.seasonOffset! : 0;
          const episodeOffset = Number.isFinite(body?.episodeOffset) ? body!.episodeOffset! : 0;

          const updated: number[] = [];
          for (const row of rows) {
            if (row.locked === 1) continue;
            if (wanted && !wanted.has(row.id)) continue;
            if (row.scene_season == null || row.scene_episode == null) continue;

            let targetSeason: number;
            let targetEpisode: number;
            const explicit = targetMap.get(row.id);
            if (explicit) {
              targetSeason = explicit.targetSeason;
              targetEpisode = explicit.targetEpisode;
            } else {
              targetSeason = row.scene_season + seasonOffset;
              targetEpisode = row.scene_episode + episodeOffset;
            }

            const ok = db.lockMappingRow(req.params.id!, row.id, {
              target_season: targetSeason,
              target_episode: targetEpisode,
              target_absolute: undefined,
            });
            if (ok) updated.push(row.id);
          }

          db.logEvent({
            type: 'mapping',
            entityType: 'show',
            entityId: req.params.id!,
            message: `Bulk mapping fix: locked ${updated.length} row${updated.length === 1 ? '' : 's'} (scene->provider ${seasonOffset >= 0 ? '+' : ''}${seasonOffset}S, ${episodeOffset >= 0 ? '+' : ''}${episodeOffset}E)`,
          });

          const { summarizeSync: summarizeSyncDynamic } = await import("../core/episode_mappings");
          return json({ ok: true, updated: updated.length, ...summarizeSyncDynamic(db, req.params.id!) });
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
          const fileMap = db.getCurrentEpisodeFilesByShow(req.params.id!);
          return json(
            episodes.map((e: any) => {
              const file = fileMap.get(`${e.season_number}:${e.episode_number}`);
              return {
                season: e.season_number,
                episode: e.episode_number,
                absoluteNumber: e.absolute_number,
                title: e.title,
                filePath: e.file_path,
                tracked: !!e.is_tracked,
                airDate: e.air_date || null,
                airTime: e.air_time || null,
                expectedReleaseAt: e.expected_release_at || null,
                // Granular on-disk file + release provenance (features:
                // "what file do I actually have" and "which release did it
                // come from").
                file: file
                  ? {
                      path: file.file_path,
                      name: cleanReleaseName(file.original_name),
                      size: file.file_size,
                      sourceKind: file.source_kind,
                      releaseTitle: file.release_title,
                      indexerName: file.indexer_name,
                      publishDate: file.publish_date,
                      importedAt: file.imported_at,
                      media: serializeFileMedia(file),
                    }
                  : null,
                searchMode: e.search_mode || 'auto',
              };
            }),
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
          const grabber = new GrabberService(config, systemManager.getWatcher() ?? undefined);
          const season = parseInt(req.params.season!, 10);
          const episode = parseInt(req.params.episode!, 10);
          const result = await grabber.grabBestRelease(req.params.id!, season, episode);
          return json({ ...result, bestRelease: result.bestRelease ? serializeRelease(result.bestRelease) : undefined, release: result.release ? serializeRelease(result.release) : undefined });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Full granular file/release list for a show - every file ever stored,
    // live rows first. Powers the "what exactly do I have on disk" view on
    // the show detail page (which release it came from, indexer, publish
    // date, size, when it was imported).
    "/api/shows/:id/files": {
      async GET(req: RouteReq) {
        try {
          const files = db.listEpisodeFilesByShow(req.params.id!);
          const show = db.getShow(req.params.id!);
          return json({
            showId: req.params.id!,
            showTitle: show?.title ?? null,
            releaseDelayMinutes: show?.release_delay_minutes ?? null,
            files: files.map((f) => ({
              season: f.season_number,
              episode: f.episode_number,
              path: f.file_path,
              name: cleanReleaseName(f.original_name),
              size: f.file_size,
              sourceKind: f.source_kind,
              releaseTitle: f.release_title,
              indexerName: f.indexer_name,
              publishDate: f.publish_date,
              importedAt: f.imported_at,
              isCurrent: !!f.is_current,
              media: serializeFileMedia(f),
            })),
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/grab": {
      async POST(req: RouteReq) {
        try {
          const config = loadConfig();
          const grabber = new GrabberService(config, systemManager.getWatcher() ?? undefined);
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
          const grabber = new GrabberService(config, systemManager.getWatcher() ?? undefined);
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
          const grabber = new GrabberService(config, systemManager.getWatcher() ?? undefined);
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

    "/api/shows/:id/seasons/:season/episodes/:episode/trace": {
      async GET(req: RouteReq) {
        try {
          const showId = req.params.id!;
          const season = parseInt(req.params.season!, 10);
          const episode = parseInt(req.params.episode!, 10);
          const events = db.listPipelineEvents({ showId, seasonNumber: season, episodeNumber: episode });
          return json(
            events.map((e: any) => ({
              id: e.id,
              stage: e.stage,
              eventType: e.event_type,
              reasonCode: e.reason_code,
              reasonCategory: e.reason_category,
              message: e.message,
              releaseTitle: e.release_title,
              indexerName: e.indexer_name,
              metadata: e.metadata_json ? JSON.parse(e.metadata_json) : null,
              createdAt: toIsoUtc(e.created_at),
            })),
          );
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/shows/:id/seasons/:season/episodes/:episode/diagnose": {
      async GET(req: RouteReq) {
        try {
          const showId = req.params.id!;
          const season = parseInt(req.params.season!, 10);
          const episode = parseInt(req.params.episode!, 10);
          const latest = db.getLatestPipelineEvent(showId, season, episode);
          if (!latest) {
            return json({ hasIssue: false, diagnosis: null, suggestedAction: null });
          }

          const reasonDef = latest.reason_code ? describeReasonCode(latest.reason_code) : undefined;
          const isFailure = latest.stage === "FAILED" || (latest.reason_code && latest.reason_code !== "GRAB_SUCCEEDED");

          return json({
            hasIssue: isFailure,
            event: {
              id: latest.id,
              stage: latest.stage,
              eventType: latest.event_type,
              message: latest.message,
              reasonCode: latest.reason_code,
              createdAt: latest.created_at ? toIsoUtc(latest.created_at) : null,
            },
            diagnosis: reasonDef
              ? {
                  label: reasonDef.label,
                  category: reasonDef.category,
                  confidence: reasonDef.confidence,
                  suggestedAction: reasonDef.suggestedAction,
                }
              : null,
            suggestedAction: reasonDef?.suggestedAction ?? null,
          });
        } catch (err) {
          return errorResponse(err, 500);
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
          // One extra pass to attach the live file/release detail per episode
          // (used by the dashboard "available" chip + calendar).
          const filesByShow = new Map<string, Map<string, any>>();
          for (const ep of episodes) {
            const showId = ep.show_id;
            if (!filesByShow.has(showId)) filesByShow.set(showId, db.getCurrentEpisodeFilesByShow(showId));
          }
          return json(
            episodes.map((ep: any) => ({
              showId: ep.show_id,
              showTitle: ep.show_title,
              episodeTitle: ep.title,
              season: ep.season_number,
              episode: ep.episode_number,
              airDate: ep.air_date,
              airTime: ep.air_time,
              expectedReleaseAt: ep.expected_release_at,
              filePath: ep.file_path ?? null,
              file: (() => {
                const f = filesByShow.get(ep.show_id)?.get(`${ep.season_number}:${ep.episode_number}`);
                return f ? {
                  path: f.file_path,
                  name: cleanReleaseName(f.original_name),
                  releaseTitle: f.release_title,
                  indexerName: f.indexer_name,
                  publishDate: f.publish_date,
                  sourceKind: f.source_kind,
                  media: serializeFileMedia(f),
                } : null;
              })(),
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
