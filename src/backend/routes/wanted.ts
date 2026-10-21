import { db } from '../db';
import { listCutoffUnmetEpisodes, giveUpPolicy } from '../core/cutoff';
import { json, errorResponse, loadConfig, type RouteReq } from './_shared';

/**
 * Cutoff unmet: tracked auto-mode episodes whose file is below their quality
 * profile's cutoff (core/cutoff.ts). In-flight grabs and the upgrade-search
 * backoff are ignored - this is the full list, not the auto-grabber's
 * per-cycle slice. Episodes the give-up policy stopped searching are not
 * counted; `?includeGivenUp=1` lists them too (flagged `givenUp`) with their
 * own `givenUp` count. `?profile=<id>` limits to one quality profile (the
 * Quality settings view). `?count=1` skips the rows.
 */
export function wantedRoutes() {
  return {
    "/api/wanted/cutoff": {
      async GET(req: RouteReq) {
        try {
          const url = new URL(req.url);
          const includeGivenUp = url.searchParams.get('includeGivenUp') === '1';
          const profileId = url.searchParams.get('profile') || undefined;
          let policy = giveUpPolicy(null);
          try { policy = giveUpPolicy(loadConfig()); } catch {}
          const all = listCutoffUnmetEpisodes(db, { giveUp: policy, includeGivenUp: true, profileId });
          const active = all.filter(r => !r.givenUp);
          const givenUp = all.length - active.length;
          const rows = includeGivenUp ? [...active, ...all.filter(r => r.givenUp)] : active;
          if (url.searchParams.get('count') === '1') return json({ count: active.length, givenUp });
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 5000);
          return json({
            count: active.length,
            givenUp,
            policy,
            episodes: rows.slice(0, limit).map(r => ({
              showId: r.showId,
              showTitle: r.showTitle,
              season: r.season,
              episode: r.episode,
              currentQuality: r.currentQuality,
              cutoff: r.cutoffName,
              profile: r.profileName,
              lastSearchedAt: r.lastSearchedAt,
              upgradeMisses: r.upgradeMisses,
              givenUp: r.givenUp,
            })),
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },
  };
}
