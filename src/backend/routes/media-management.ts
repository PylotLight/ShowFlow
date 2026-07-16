import { db } from "../db";
import { json, errorResponse } from "./_shared";

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

    "/api/profiles": {
      async GET() {
        try {
          return json(db.listProfiles());
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          db.saveProfile(body);
          return json({ ok: true }, { status: 201 });
        } catch (err) {
          return errorResponse(err);
        }
      },
    },

    "/api/profiles/:id": {
      async DELETE(req: Request & { params: Record<string, string> }) {
        try {
          db.removeProfile(req.params.id!);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

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

    "/api/profiles/:id/indexers": {
      async PUT(req: Request & { params: Record<string, string> }) {
        try {
          const body = await req.json();
          db.saveProfileIndexers(req.params.id!, body);
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
