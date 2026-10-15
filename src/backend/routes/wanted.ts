import { db } from '../db';
import { listCutoffUnmetEpisodes } from '../core/cutoff';
import { json, errorResponse, type RouteReq } from './_shared';

/**
 * Wanted > Cutoff unmet: tracked auto-mode episodes whose file is below
 * their quality profile's cutoff (core/cutoff.ts). In-flight grabs and the
 * upgrade-search backoff are ignored - this is the full list, not the
 * auto-grabber's per-cycle slice. `?count=1` skips the rows.
 */
export function wantedRoutes() {
  return {
    "/api/wanted/cutoff": {
      async GET(req: RouteReq) {
        try {
          const url = new URL(req.url);
          const rows = listCutoffUnmetEpisodes(db);
          if (url.searchParams.get('count') === '1') return json({ count: rows.length });
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 5000);
          return json({
            count: rows.length,
            episodes: rows.slice(0, limit).map(r => ({
              showId: r.showId,
              showTitle: r.showTitle,
              season: r.season,
              episode: r.episode,
              currentQuality: r.currentQuality,
              cutoff: r.cutoffName,
              profile: r.profileName,
              lastSearchedAt: r.lastSearchedAt,
            })),
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
