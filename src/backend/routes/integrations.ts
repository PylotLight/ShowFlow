import { db, SonarrConfigSchema, JellyfinConfigSchema } from "../db";
import { SonarrImporter, type SonarrTypeMapping, type ImportResult } from "../providers/sonarr/import";
import { JellyfinSync } from "../providers/jellyfin/sync";
import { backgroundJobs } from "../core/background_jobs";
import { LibraryScanner } from "../core/library_scanner";
import { json, errorResponse, loadConfig, invalidateConfigCache, getSonarrClient, getJellyfinClient } from "./_shared";

/** Stores import results by jobId so the frontend can fetch them after completion. */
const importResultsStore = new Map<string, ImportResult[]>();

export function integrationRoutes() {
  return {

    "/api/sonarr/import/:jobId/results": {
      async GET(req: Request & { params: Record<string, string> }) {
        const results = importResultsStore.get(req.params.jobId!);
        if (!results) return errorResponse("Results not found", 404);
        return json(results);
      },
    },

    "/api/sonarr/settings": {
      async GET() {
        try {
          const raw = db.getSetting('sonarr');
          if (!raw) return json({ enabled: false, baseUrl: '', apiKey: '' });
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const config = SonarrConfigSchema.parse(parsed);
          return json({ ...config, apiKey: config.apiKey ? '********' : '' });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json() as Record<string, any>;
          const existing = db.getSetting('sonarr');
          let merged = body;
          if (existing) {
            try {
              const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
              merged = { ...parsed, ...body };
            } catch { }
          }
          const result = SonarrConfigSchema.safeParse(merged);
          if (!result.success) {
            return errorResponse(result.error.issues.map(i => i.message).join("; "));
          }
          db.setSetting('sonarr', result.data);
          invalidateConfigCache();
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/sonarr/test": {
      async GET() {
        try {
          const client = getSonarrClient();
          if (!client) return json({ ok: false, message: "Sonarr not configured" });
          const result = await client.test();
          return json(result);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/sonarr/series": {
      async GET() {
        try {
          const client = getSonarrClient();
          if (!client) return json({ ok: false, message: "Sonarr not configured" });
          const series = await client.getSeries();
          return json(series);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/sonarr/import": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const raw = db.getSetting('sonarr');
          if (!raw) return errorResponse("Sonarr not configured", 400);
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const config = SonarrConfigSchema.parse(parsed);
          if (!config.enabled || !config.baseUrl || !config.apiKey) {
            return errorResponse("Sonarr is not fully configured", 400);
          }

          const body = await req.json() as { seriesIds?: number[]; typeMapping?: SonarrTypeMapping } | undefined;
          const appConfig = loadConfig();
          const importer = new SonarrImporter(config.baseUrl, config.apiKey, config.apiVersion ?? 'v3', appConfig);

          const series = body?.seriesIds;

          // Every import - regardless of size - registers against the
          // Background Activity registry (design-brief-platform-ux-systems.md
          // §2) so it's visible from the header the moment it starts, whether
          // the caller is the onboarding wizard's "wait here" path or the
          // "keep configuring" background path. The wizard/UI polls
          // GET /api/background-jobs/:id (or the list endpoint) rather than a
          // Sonarr-specific status route, so this same job also shows up for
          // an import kicked off from IntegrationsTab.tsx outside onboarding
          // (design-brief-platform-ux-systems.md §4) with no separate code path.
          const jobId = crypto.randomUUID();
          backgroundJobs.register({
            id: jobId,
            type: 'sonarr-import',
            label: `Importing ${series?.length ?? 'all'} series from Sonarr`,
            total: series?.length,
          });

          const runImport = async () => {
            try {
              const results = await importer.importSeries(series, body?.typeMapping, jobId);
              importResultsStore.set(jobId, results);
              // Post-import library scan (design-brief-onboarding-wizard.md §2 /
              // design-brief-platform-ux-systems.md §5): newly imported shows
              // should immediately reflect files already present in their root
              // folders rather than waiting for the next scheduled scan.
              try {
                await new LibraryScanner(appConfig).scan();
              } catch (scanErr) {
                console.warn('[sonarr] Post-import library scan failed:', scanErr);
              }
              return results;
            } catch (err) {
              backgroundJobs.fail(jobId, err instanceof Error ? err.message : String(err));
              throw err;
            }
          };

          runImport().then(results => {
            console.log(`[sonarr] Import completed: ${results.filter(r => r.status === 'imported').length} imported, ${results.filter(r => r.status === 'existing').length} existing, ${results.filter(r => r.status === 'error').length} errors`);
          }).catch(err => {
            console.error('[sonarr] Import failed:', err);
          });

          return json({ jobId });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/jellyfin/settings": {
      async GET() {
        try {
          const raw = db.getSetting('jellyfin');
          if (!raw) return json({ enabled: false, baseUrl: '', apiKey: '' });
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const config = JellyfinConfigSchema.parse(parsed);
          return json({ ...config, apiKey: config.apiKey ? '********' : '' });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json() as Record<string, any>;
          const existing = db.getSetting('jellyfin');
          let merged = body;
          if (existing) {
            try {
              const parsed = typeof existing === 'string' ? JSON.parse(existing) : existing;
              merged = { ...parsed, ...body };
            } catch { }
          }
          const result = JellyfinConfigSchema.safeParse(merged);
          if (!result.success) {
            return errorResponse(result.error.issues.map(i => i.message).join("; "));
          }
          db.setSetting('jellyfin', result.data);
          invalidateConfigCache();
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/jellyfin/test": {
      async GET() {
        try {
          const client = getJellyfinClient();
          if (!client) return json({ ok: false, message: "Jellyfin not configured" });
          const result = await client.test();
          return json(result);
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/jellyfin/users": {
      async GET() {
        try {
          const client = getJellyfinClient();
          if (!client) return json({ ok: false, message: "Jellyfin not configured" });
          const users = await client.getUsers();
          return json(users.map(u => ({ id: u.Id, name: u.Name, isAdmin: u.IsAdministrator })));
        } catch (err) {
          return errorResponse(err, 502);
        }
      },
    },

    "/api/jellyfin/sync": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const raw = db.getSetting('jellyfin');
          if (!raw) return errorResponse("Jellyfin not configured", 400);
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const config = JellyfinConfigSchema.parse(parsed);
          if (!config.enabled || !config.baseUrl || !config.apiKey) {
            return errorResponse("Jellyfin is not fully configured", 400);
          }

          const syncer = new JellyfinSync(config.baseUrl, config.apiKey);
          const result = await syncer.sync();
          return json(result);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
