import { db } from "../db";
import { json, errorResponse } from "./_shared";
import { testReleaseName } from "../core/release_test";
import {
  listProfileModels, getProfileModel, saveProfileModel, resolveProfileTerms, profileUsage, clearMigrationNote,
  listCustomTerms, saveCustomTerm, removeCustomTerm, termLibrary,
} from "../db/quality_model";
import { TERM_GROUPS, MODE_WEIGHT, PRESETS, SOURCE_ORDER, RESOLUTIONS } from "../core/quality_terms";
import { SOURCE_LABELS } from "../core/release_quality";
import { buildMigrationPreview } from "../core/quality_migration_preview";

function profilePayload(p: NonNullable<ReturnType<typeof getProfileModel>>, usage: ReturnType<typeof profileUsage>) {
  return { ...p, resolvedTerms: resolveProfileTerms(db, p), usedBy: usage[p.id] ?? [] };
}

export function mediaManagementRoutes() {
  return {

    "/api/qualities": {
      async GET() {
        try {
          return json(db.listQualities());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          db.saveQuality(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/qualities/:id": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeQuality(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Streamlined profiles: resolution target/min, source skips, terms, upgrade-until.
    "/api/profiles": {
      async GET() {
        try {
          const usage = profileUsage(db);
          return json(listProfileModels(db).map(p => profilePayload(p, usage)));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          const saved = saveProfileModel(db, body);
          return json(profilePayload(saved, profileUsage(db)), { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/profiles/:id": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const p = getProfileModel(db, req.params.id!);
          if (!p) return errorResponse("unknown profile", 404);
          return json(profilePayload(p, profileUsage(db)));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          const used = profileUsage(db)[req.params.id!] ?? [];
          if (used.length) return errorResponse(`profile is used by ${used.map(u => u.name).join(", ")}; pick another profile there first`, 409);
          db.removeProfile(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Dismiss the one-time "we merged 5 formats into HEVC" conversion notice.
    "/api/profiles/:id/migration-note": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          clearMigrationNote(db, req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Built-in term library + custom terms + presets for the Quality screen.
    "/api/quality/terms": {
      async GET() {
        try {
          return json({
            groups: TERM_GROUPS,
            builtins: termLibrary(),
            custom: listCustomTerms(db),
            modeWeights: MODE_WEIGHT,
            sources: SOURCE_ORDER.map(id => ({ id, label: SOURCE_LABELS[id] })),
            resolutions: RESOLUTIONS,
            presets: PRESETS,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/quality/custom-terms": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          const regex = typeof body?.regex === "string" ? body.regex.trim() : "";
          if (!name || !regex) return errorResponse("name and regex are required");
          try { new RegExp(regex, "i"); } catch { return errorResponse("that regex doesn't compile"); }
          const id = typeof body?.id === "string" && body.id ? body.id : `ct_${crypto.randomUUID().slice(0, 8)}`;
          saveCustomTerm(db, { id, name, regex });
          return json({ id, name, regex }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/quality/custom-terms/:id": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          removeCustomTerm(db, req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // Dry-run: old vs new score/decision on recent grabs + current files.
    // ?limit=200 (max 2000), ?flips=1 to list only what changed.
    "/api/quality/migration-preview": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          const url = new URL(req.url);
          const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
          const onlyFlips = url.searchParams.get("flips") === "1";
          return json(buildMigrationPreview(db, { limit, onlyFlips }));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    // ---- legacy (read-only for one release; no longer affects scoring) ----

    "/api/profiles/:id/formats": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          return json(db.getProfileFormats(req.params.id!));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const { formatId, type } = await req.json();
          db.addProfileFormat(req.params.id!, formatId, type);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          const { formatId } = await req.json();
          db.removeProfileFormat(req.params.id!, formatId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/profiles/:id/qualities": {
      async GET(req: Request & { params: Record<string, string> }) {
        try {
          return json(db.getProfileQualities(req.params.id!));
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const { qualityId } = await req.json();
          if (!qualityId) return errorResponse("qualityId is required");
          db.addProfileQuality(req.params.id!, qualityId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          const { qualityId } = await req.json();
          if (!qualityId) return errorResponse("qualityId is required");
          db.removeProfileQuality(req.params.id!, qualityId);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    // Dry-run a release title against a profile: parsed resolution/source,
    // quality rank, per-term hits, total, allowed, upgrade-until.
    "/api/quality/test": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json().catch(() => ({}));
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          const profileId = typeof body?.profileId === "string" ? body.profileId : "";
          if (!name) return errorResponse("name is required");
          if (!profileId || !db.getProfile(profileId)) return errorResponse("unknown profileId", 404);
          return json(testReleaseName(name, profileId));
        } catch (err) {
          return errorResponse(err, 500);
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
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          db.saveCustomFormat(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/custom-formats/:id": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeCustomFormat(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
