import { db, ProwlarrConfigSchema, SonarrConfigSchema, JellyfinConfigSchema } from "../db";
import { json, errorResponse, loadConfig, invalidateConfigCache } from "./_shared";

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
          return json({ ok: true });
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
            return json({ ok: true });
          }
          db.setSetting(key, value);
          invalidateConfigCache();
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
