import { db, ProwlarrConfigSchema, SonarrConfigSchema, JellyfinConfigSchema } from "../db";
import { json, errorResponse, loadConfig, invalidateConfigCache } from "./_shared";
import { renderEpisodeName, formatForSeriesType, type NamingConfig } from "../core/episode_naming";

export function configRoutes() {
  return {

    "/api/config": {
      async GET() {
        try {
          return json(loadConfig());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async PATCH(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json()) as Record<string, any>;
          for (const [k, v] of Object.entries(body)) {
            db.setSetting(k, v);
          }
          invalidateConfigCache();
          const keys = Object.keys(body).join(', ');
          db.logEvent({ type: 'config', entityType: 'system', message: `Settings saved: ${keys}` });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/naming/preview": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json().catch(() => ({}))) as Partial<NamingConfig> & { seriesTitle?: string; originalFilename?: string };
          const cfg = loadConfig() as unknown as NamingConfig & { seriesTitle?: string; originalFilename?: string };
          const seriesTitle = body?.seriesTitle || cfg?.seriesTitle || "The Series Title's";
          const originalFilename = body?.originalFilename || cfg?.originalFilename || "The.Series.Title's.S01E01.WEBRip.1080p.HEVC.x265.NSW.mkv";
          const config: NamingConfig = {
            standardEpisodeFormat: body?.standardEpisodeFormat ?? cfg?.standardEpisodeFormat,
            dailyEpisodeFormat: body?.dailyEpisodeFormat ?? cfg?.dailyEpisodeFormat,
            animeEpisodeFormat: body?.animeEpisodeFormat ?? cfg?.animeEpisodeFormat,
            multiEpisodeStyle: body?.multiEpisodeStyle ?? cfg?.multiEpisodeStyle,
            replaceIllegalCharacters: body?.replaceIllegalCharacters ?? cfg?.replaceIllegalCharacters,
            colonReplacement: body?.colonReplacement ?? cfg?.colonReplacement,
          };

          const media = { height: 1080, codec: 'hevc', hdr: false, audioCodec: 'eac3', audioChannels: 6, container: 'mkv' };

          const sample = (fmt: string, episodes: { season: number; episode: number; absoluteNumber?: number; title?: string; airDate?: string }[], seriesType: 'standard' | 'daily' | 'anime') =>
            renderEpisodeName({ seriesTitle, seriesType, episodes, originalFilename, media, config }, fmt);

          const fmt = (t: string) => formatForSeriesType(t, config);
          return json({
            standard: sample(fmt('standard'), [{ season: 1, episode: 1, title: "Episode Title" }], 'standard'),
            standardMulti: sample(fmt('standard'), [{ season: 1, episode: 1, title: "Episode Title" }, { season: 1, episode: 2, title: "Episode Title" }, { season: 1, episode: 3, title: "Episode Title" }], 'standard'),
            daily: sample(fmt('daily'), [{ season: 1, episode: 1, title: "Episode Title", airDate: "2013-10-30" }], 'daily'),
            anime: sample(fmt('anime'), [{ season: 1, episode: 1, absoluteNumber: 1, title: "Episode Title" }], 'anime'),
            animeMulti: sample(fmt('anime'), [{ season: 1, episode: 1, absoluteNumber: 1, title: "Episode Title" }, { season: 1, episode: 2, absoluteNumber: 2, title: "Episode Title" }], 'anime'),
          });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/show-profiles": {
      async GET() {
        try {
          return json(db.listShowProfiles());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const { id, name, rootFolderPath } = await req.json();
          if (!id || !name || !rootFolderPath) return errorResponse("id, name, and rootFolderPath are required");
          db.saveShowProfile(id, name, rootFolderPath);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/show-profiles/:id": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeShowProfile(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/library-types": {
      async GET() {
        try {
          return json(db.listLibraryTypes());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json() as { id?: string; name?: string; rootFolderPath?: string; qualityProfileId?: string; indexers?: any; isDefault?: boolean };
          if (!body.id || !body.name) return errorResponse("id and name are required");
          db.saveLibraryType({
            id: body.id,
            name: body.name,
            rootFolderPath: body.rootFolderPath,
            qualityProfileId: body.qualityProfileId,
            indexers: body.indexers,
            isDefault: body.isDefault,
          });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/library-types/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const type = db.getLibraryType(req.params.id!);
          if (!type) return errorResponse("Library type not found", 404);
          return json(type);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeLibraryType(req.params.id!);
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
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const { key, value } = await req.json();
          if (!key) return errorResponse("Key is required");
          if (key === "prowlarr") {
            const existing = db.getSetting('prowlarr');
            let merged = value;
            if (existing) {
              try {
                const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
                merged = { ...parsed, ...value };
              } catch { }
            }
            const result = ProwlarrConfigSchema.safeParse(merged);
            if (!result.success) {
              return errorResponse(result.error.issues.map(i => i.message).join("; "));
            }
            db.setSetting(key, result.data);
            invalidateConfigCache();
            db.logEvent({ type: 'config', entityType: 'system', message: 'Prowlarr configuration saved' });
            return json({ ok: true });
          }
          if (key === "sonarr") {
            const existing = db.getSetting('sonarr');
            let merged = value;
            if (existing) {
              try {
                const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
                merged = { ...parsed, ...value };
              } catch { }
            }
            const result = SonarrConfigSchema.safeParse(merged);
            if (!result.success) {
              return errorResponse(result.error.issues.map(i => i.message).join("; "));
            }
            db.setSetting(key, result.data);
            invalidateConfigCache();
            db.logEvent({ type: 'config', entityType: 'system', message: 'Sonarr configuration saved' });
            return json({ ok: true });
          }
          if (key === "jellyfin") {
            const existing = db.getSetting('jellyfin');
            let merged = value;
            if (existing) {
              try {
                const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
                merged = { ...parsed, ...value };
              } catch { }
            }
            const result = JellyfinConfigSchema.safeParse(merged);
            if (!result.success) {
              return errorResponse(result.error.issues.map(i => i.message).join("; "));
            }
            db.setSetting(key, result.data);
            invalidateConfigCache();
            db.logEvent({ type: 'config', entityType: 'system', message: 'Jellyfin configuration saved' });
            return json({ ok: true });
          }
          if (key.startsWith('onboarding.')) {
            db.setSetting(key, value);
            invalidateConfigCache();
            return json({ ok: true });
          }
          db.setSetting(key, value);
          invalidateConfigCache();
          db.logEvent({ type: 'config', entityType: 'system', message: `Setting "${key}" saved` });
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
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

  };
}
