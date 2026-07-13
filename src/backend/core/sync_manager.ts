import { db, type Config } from '../db';
import { ProviderFactory, type ProviderType } from '../providers/factory';
import { debugLog } from './debug';

export class SyncManager {
  constructor(private config: Config) {}

  async syncShow(showId: string) {
    const show = db.getShow(showId);
    if (!show) {
      debugLog(`Sync failed: Show ${showId} not found.`);
      return;
    }

    try {
      // Resolve per-role providers. If no role config is set, both fall
      // through to the same primary provider so existing behaviour is unchanged.
      const metadataProviderInfo = db.getProviderForRole(showId, 'metadata');
      const airtimeProviderInfo = db.getProviderForRole(showId, 'airtime');

      // 1. Update show metadata (title, images, etc.)
      if (metadataProviderInfo) {
        const metadataProvider = ProviderFactory.getProvider(metadataProviderInfo.providerType as ProviderType, this.config);
        const liveShow = await metadataProvider.getShow(metadataProviderInfo.providerId);
        db.updateShowSyncData(showId, metadataProviderInfo.providerType, {
          title: liveShow.title,
          year: liveShow.year,
          originalTitle: liveShow.originalTitle,
          romanizedTitle: liveShow.romanizedTitle,
          metadata: liveShow.metadata,
        });
      }

      // 2. Update episodes with air dates (may be from a different provider)
      if (airtimeProviderInfo) {
        const airtimeProvider = ProviderFactory.getProvider(airtimeProviderInfo.providerType as ProviderType, this.config);
        const episodes = await airtimeProvider.getEpisodes(airtimeProviderInfo.providerId);

        if (episodes.length > 0) {
          // Reconcile season numbers: if the airtime provider uses season 1
          // exclusively (AniList) but the metadata provider splits into seasons,
          // preserve the existing season mapping.
          const existingEpisodes = db.listAllEpisodes(showId);
          const existingMap = new Map(
            existingEpisodes.map((e: any) => [e.absolute_number || e.episode_number, e])
          );

          db.syncEpisodes(
            showId,
            episodes.map((e) => {
              // Try to find an existing episode by absolute number to preserve its season
              const existing = existingMap.get(e.absoluteNumber ?? e.episode);
              return {
                seasonNumber: existing?.season_number ?? e.season,
                episodeNumber: e.episode,
                absoluteNumber: e.absoluteNumber,
                title: e.title,
                airDate: e.airDate,
              };
            })
          );
        }
      }

      debugLog(`Successfully synced show: ${show.title}`);
      db.logEvent({
        type: 'sync',
        entityType: 'show',
        entityId: showId,
        message: `Synced show "${show.title}"`,
      });
    } catch (err) {
      debugLog(`Error syncing show ${showId}: ${err}`);
      throw err;
    }
  }

  async syncAllShows() {
    const shows = db.listShows();
    const now = new Date();
    let syncedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const show of shows) {
      // --- Intelligence: Determine if this show actually needs syncing ---
      
      // 1. If the show has never been updated (or updated very long ago), sync it.
      const lastUpdated = show.last_updated ? new Date(show.last_updated) : new Date(0);
      const daysSinceUpdate = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      
      // 2. Prioritize shows that have upcoming episodes.
      const hasUpcoming = db.hasUpcomingEpisodes(show.id);
      
      // Logic:
      // - If it has upcoming episodes: Sync every 3 days to ensure air dates/titles are correct.
      // - Otherwise: Sync every 30 days (maintenance mode).
      // - New shows (lastUpdated ~ 0) always sync.
      
      const syncIntervalDays = hasUpcoming ? 3 : 30;
      if (daysSinceUpdate < syncIntervalDays) {
        skippedCount++;
        continue;
      }

      try {
        await this.syncShow(show.id);
        syncedCount++;
        db.logEvent({
          type: 'sync',
          entityType: 'show',
          entityId: show.id,
          message: `Successfully synced show ${show.title}`,
        });
      } catch (err) {
        errorCount++;
      }
    }

    return { syncedCount, errorCount, skippedCount };
  }
}
