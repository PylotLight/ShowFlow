import { fileURLToPath } from 'bun';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

import { seedDefaults, migrateQualityIds } from './init';
import { convertBuiltinGroupTerms, convertLegacyProfiles } from './quality_model';
import { backfillShowTitles } from './shows';
import { extractReleaseMeta } from '../core/release_meta';
import * as shows from './shows';
import * as config from './config';
import * as system from './system';
import * as pipeline from './pipeline';
import * as analytics from './analytics';
import * as health from './health';
import * as grabs from './grabs';
import * as blocklist from './blocklist';
import * as mappings from './mappings';
import * as episodeFiles from './episode_files';
import * as episodeStatus from './episode_status';
import { resolveImagesDir } from '../core/image_store';
import { emitConnectSignal } from '../core/connect/bus';

export type { Config, ProwlarrConfig, SonarrConfig, JellyfinConfig, NativeIndexerConfig } from './schemas';
export {
  ConfigSchema,
  ProwlarrConfigSchema,
  SonarrConfigSchema,
  JellyfinConfigSchema,
  NativeIndexerConfigSchema,
  NativeIndexersConfigSchema,
  DEFAULT_CACHE_TTL_MS,
} from './schemas';

export class DatabaseManager {
  public db: Database;
  public drizz: ReturnType<typeof drizzle>;
  private dbPath: string;
  private _imagesDir: string | null = null;

  constructor(dbPath = 'showflow.db') {
    this.dbPath = dbPath;
    this.db = DatabaseManager.open(this.dbPath);
    this.drizz = drizzle(this.db, { schema });
    this.init();
  }

  /**
   * Open a connection with the pragmas every ShowFlow connection wants.
   * WAL lets the API keep reading while the scanner / grabber write (rollback
   * journal blocked every reader for the duration of each write txn), and
   * busy_timeout turns the occasional writer-vs-writer overlap (backup's
   * second connection, cleanup jobs) into a short wait instead of an
   * immediate SQLITE_BUSY. synchronous=NORMAL is the recommended pairing
   * with WAL: still crash-safe, just no fsync on every commit.
   * journal_mode is a no-op for :memory: DBs (tests), which is fine.
   */
  /** Where artwork files live (core/image_store.ts); resolved on first use. */
  get imagesDir(): string {
    if (!this._imagesDir) this._imagesDir = resolveImagesDir(this.dbPath);
    return this._imagesDir;
  }

  static open(dbPath: string): Database {
    const conn = new Database(dbPath);
    // Only takes effect on a brand-new (empty) DB file; an existing DB keeps
    // its mode until a full VACUUM (the manual Settings > Analytics vacuum
    // converts it — see core/db_cleanup.ts). Never VACUUM here: on a large
    // DB that would stall boot/activation for minutes.
    conn.run('PRAGMA auto_vacuum = INCREMENTAL');
    conn.run('PRAGMA journal_mode = WAL');
    conn.run('PRAGMA synchronous = NORMAL');
    conn.run('PRAGMA busy_timeout = 5000');
    conn.run('PRAGMA temp_store = MEMORY');
    conn.run('PRAGMA foreign_keys = ON');
    return conn;
  }

  reload(altPath?: string) {
    try { this.db.close(); } catch {}
    this.dbPath = altPath ?? this.dbPath;
    this.db = DatabaseManager.open(this.dbPath);
    this.drizz = drizzle(this.db, { schema });
    this.init();
  }

  /**
   * Swap the on-disk DB file (backup restore). Under WAL the live file has
   * -wal/-shm companions; copying a backup over just the main file would let
   * the stale WAL be replayed on top of it on the next open (= corruption).
   * So: checkpoint + close, drop the companions, let the caller write the
   * new file, then reopen.
   */
  async replaceFile(write: (dbPath: string) => Promise<void>) {
    // Fold the WAL back into the main file first. If another connection is
    // mid-read the checkpoint can't truncate — bail rather than delete a WAL
    // that still holds committed pages.
    const ck = this.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | null;
    if (ck && ck.busy) throw new Error('Database is busy (checkpoint blocked) — retry the restore in a moment');
    this.db.close(true);
    const { unlink } = await import('node:fs/promises');
    for (const suffix of ['-wal', '-shm']) {
      await unlink(this.dbPath + suffix).catch(() => {});
    }
    try {
      await write(this.dbPath);
    } finally {
      this.reload();
    }
  }

  /**
   * Cheap periodic upkeep (daily, from the pipeline-cleanup task):
   *  - PRAGMA optimize: refresh planner stats for tables whose shape changed
   *    (the high-churn event tables), so the new indexes actually get used.
   *  - incremental_vacuum: hand pages freed by retention deletes back to the
   *    filesystem, capped per run so a huge freelist can't stall the loop.
   *    No-op unless the DB is in auto_vacuum=INCREMENTAL mode.
   *  - wal_checkpoint(TRUNCATE): fold the WAL in and shrink the -wal file,
   *    which otherwise stays at its high-water size.
   */
  runMaintenance(maxVacuumPages = 25_600): { autoVacuum: number; freelistBefore: number; freelistAfter: number } {
    const autoVacuum = (this.db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number } | null)?.auto_vacuum ?? 0;
    const freelistBefore = (this.db.query('PRAGMA freelist_count').get() as { freelist_count: number } | null)?.freelist_count ?? 0;
    this.db.run('PRAGMA optimize');
    if (autoVacuum === 2 && freelistBefore > 0) {
      this.db.run(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(maxVacuumPages))})`);
    }
    try { this.db.run('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    const freelistAfter = (this.db.query('PRAGMA freelist_count').get() as { freelist_count: number } | null)?.freelist_count ?? 0;
    return { autoVacuum, freelistBefore, freelistAfter };
  }

  close() {
    try {
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
    }
    this.db.close();
  }

  private init() {
    // Table creation/alteration lives entirely in Drizzle migrations now -
    // this applies whatever hasn't been applied yet to this DB file. Run
    // `bunx drizzle-kit generate` after changing schema.ts to produce a new
    // migration, then just start the app - no separate `migrate` command
    // to remember to run.
    //
    // Two ways this process can be running, each needing a different path:
    //   - Compiled binary (production/Docker): the Dockerfile copies
    //     src/backend/db/migrations to /bootstrap/migrations, sitting
    //     alongside the compiled `showflow` executable - so migrations
    //     live next to process.execPath.
    //   - Running from source (bun --hot src/backend/server.ts, i.e. `bun
    //     run dev`): process.execPath points at the bun runtime itself
    //     (e.g. /opt/homebrew/bin/bun), which has no migrations folder
    //     next to it. Here migrations live next to *this source file*.
    // Try both and use whichever actually has a migrations journal.
    const binaryDir = dirname(process.execPath);
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const bootstrapMigrations = process.env.SHOWFLOW_BOOTSTRAP_MIGRATIONS ?? "/bootstrap/migrations";
    const candidates = [resolve(binaryDir, 'migrations'), resolve(sourceDir, 'migrations'), bootstrapMigrations];
    const migrationsFolder = candidates.find(dir => existsSync(resolve(dir, 'meta/_journal.json'))) ?? resolve(binaryDir, 'migrations');
    migrate(this.drizz, { migrationsFolder });

    seedDefaults(this.drizz as unknown as BunSQLiteDatabase<typeof schema>);
    migrateQualityIds(this.drizz as unknown as BunSQLiteDatabase<typeof schema>);
    // One-time: legacy quality profiles (custom formats + allow-list + tier
    // cutoff) -> streamlined model (resolution target/min, source skips,
    // terms, upgrade-until). Idempotent; converted profiles are skipped.
    try {
      const converted = convertLegacyProfiles(this);
      for (const c of converted) console.log(`[quality] Converted profile "${c.name}" to the streamlined model (${c.terms} terms)${c.notes.length ? `: ${c.notes.join('; ')}` : ''}`);
    } catch (err) {
      console.warn('[quality] Profile conversion failed (engine converts in memory until it succeeds):', err);
    }
    // One-time: the built-in release-group chips became per-profile groups.
    try {
      const n = convertBuiltinGroupTerms(this);
      if (n) console.log(`[quality] Moved ${n} built-in release group term(s) to per-profile release groups`);
    } catch (err) {
      console.warn('[quality] Release group conversion failed:', err);
    }

    const titleCount = this.db.query('SELECT count(*) as c FROM show_titles').get() as { c: number } | undefined;
    if (!titleCount || titleCount.c === 0) {
      backfillShowTitles(this);
    }

    // One-time provenance backfill: rows that had file paths before the
    // episode_files table existed. Cheap guard via the column-level check
    // below so it only runs meaningfully once.
    const efCol = this.db.query(
      "SELECT count(*) as c FROM pragma_table_info('episode_files') WHERE name = 'file_path'"
    ).get() as { c: number } | undefined;
    if ((efCol?.c ?? 0) > 0) {
      const fileCount = this.db.query('SELECT count(*) as c FROM episode_files').get() as { c: number } | undefined;
      const epFileCount = this.db.query(
        "SELECT count(*) as c FROM episodes WHERE file_path IS NOT NULL AND file_path != ''"
      ).get() as { c: number } | undefined;
      if ((fileCount?.c ?? 0) === 0 && (epFileCount?.c ?? 0) > 0) {
        episodeFiles.backfillEpisodeFiles(this);
      }
    }

    // One-time fix for misattributed provenance: previously the most recent
    // grab for a show was stamped onto whatever file landed regardless of
    // whether it was the same release (e.g. a FraMeSToR REMUX grab shown as the
    // origin of a DirtyHippie RIFE file). Re-check every attributed row against
    // its landed file name and drop the grab provenance when they disagree.
    if (this.getSetting('provenance.reconciled.v1') !== '1') {
      try {
        const cleared = episodeFiles.reconcileMismatchedProvenance(this);
        if (cleared > 0) console.log(`[provenance] Cleared mismatched release provenance on ${cleared} file(s).`);
        this.setSetting('provenance.reconciled.v1', '1');
      } catch (err) {
        console.warn('[provenance] Reconciliation failed:', err);
      }
    }

    // Kick off a non-blocking media-probe backfill for episode_files rows
    // that exist but were recorded before probing existed (no container yet).
    // Probing happens in the background so startup isn't stalled while the
    // first scan re-probes the library. Idempotent: rows already probed are
    // skipped by listUnprobedEpisodeFiles.
    if ((efCol?.c ?? 0) > 0) {
      try {
        // Cheap, disk-free pass first: derive filename metadata (HDR format +
        // release tags) for every live row still missing it, including rows an
        // earlier probe already filled. Runs before the expensive re-probe so
        // the badges light up instantly.
        try {
          const untagged = episodeFiles.listEpisodeFilesMissingReleaseMeta(this);
          let tagged = 0;
          for (const row of untagged) {
            const meta = extractReleaseMeta(row.original_name ?? row.release_title);
            episodeFiles.updateEpisodeFileMedia(this, row.id, {
              hdr_format: meta.hdrFormat,
              release_tags: JSON.stringify(meta.tags),
            });
            tagged++;
          }
          if (tagged > 0) console.log(`[probe] Release-metadata backfill: tagged ${tagged} file(s).`);
        } catch {
          // non-fatal
        }

        const unprobed = episodeFiles.listUnprobedEpisodeFiles(this);
        if (unprobed.length > 0) {
          setImmediate(() => {
            void (async () => {
              const { probeMediaFile, foldProbeToColumns } = await import('../core/media_probe');
              let probed = 0;
              for (const row of unprobed) {
                try {
                  const st = await stat(row.file_path).catch(() => null);
                  if (!st) continue;
                  const m = await probeMediaFile(row.file_path);
                  if (!m) continue;
                  const cols = foldProbeToColumns(m, row.original_name ?? row.release_title);
                  if (cols) episodeFiles.updateEpisodeFileMedia(this, row.id, cols);
                  probed++;
                } catch {
                  // skip on individual probe failure
                }
              }
              console.log(`[probe] Media backfill complete: probed ${probed}/${unprobed.length} stored files.`);
            })().catch(() => {});
          });
        }
      } catch {
        // non-fatal
      }
    }
  }

  // ---- Shows -------------------------------------------------------------

  findShowsByNormalizedTitle(normalizedTitle: string) { return shows.findShowsByNormalizedTitle(this, normalizedTitle); }
  getLocalShowCandidates() { return shows.getLocalShowCandidates(this); }
  saveShow(show: Parameters<typeof shows.saveShow>[1]) { return shows.saveShow(this, show); }
  updateShowSyncData(showId: string, providerType: string, data: Parameters<typeof shows.updateShowSyncData>[3]) { return shows.updateShowSyncData(this, showId, providerType, data); }
  syncAllShowTitles(showId: string, providerType: string, show: Parameters<typeof shows.syncAllShowTitles>[3]) { return shows.syncAllShowTitles(this, showId, providerType, show); }
  getShow(showId: string) { return shows.getShow(this, showId); }
  getShowConfig(showId: string) { return shows.getShowConfig(this, showId); }
  getShowBackdropIndex(showId: string) { return shows.getShowBackdropIndex(this, showId); }
  getShowBackdropOptions(showId: string) { return shows.getShowBackdropOptions(this, showId); }
  getShowBackdropOptionsAt(showId: string) { return shows.getShowBackdropOptionsAt(this, showId); }
  saveShowBackdropOptions(showId: string, options: shows.StoredBackdropOption[]) { return shows.saveShowBackdropOptions(this, showId, options); }
  getShowBackdropPosition(showId: string) { return shows.getShowBackdropPosition(this, showId); }
  getProviderForRole(showId: string, role: 'metadata' | 'airtime') { return shows.getProviderForRole(this, showId, role); }
  setProviderRole(showId: string, providerType: string, role: 'metadata' | 'airtime', active: boolean) { return shows.setProviderRole(this, showId, providerType, role, active); }
  listShowProvidersWithRoles(showId: string) { return shows.listShowProvidersWithRoles(this, showId); }
  getShowByName(name: string) { return shows.getShowByName(this, name); }
  listShows() { return shows.listShows(this); }
  listShowSummaries() { return shows.listShowSummaries(this); }
  countShows() { return shows.countShows(this); }
  hasUpcomingEpisodes(showId: string) { return shows.hasUpcomingEpisodes(this, showId); }
  getShowByProvider(providerType: string, providerId: string) { return shows.getShowByProvider(this, providerType, providerId); }
  addShowProvider(showId: string, providerType: string, providerId: string, data?: Parameters<typeof shows.addShowProvider>[4]) { return shows.addShowProvider(this, showId, providerType, providerId, data); }
  removeShowProvider(showId: string, providerType: string) { return shows.removeShowProvider(this, showId, providerType); }
  setPrimaryProvider(showId: string, providerType: string) { return shows.setPrimaryProvider(this, showId, providerType); }
  listShowProviders(showId: string) { return shows.listShowProviders(this, showId); }

  // ---- Seasons -----------------------------------------------------------

  saveSeason(showId: string, seasonNumber: number, title?: string) { return shows.saveSeason(this, showId, seasonNumber, title); }
  getSeason(showId: string, seasonNumber: number) { return shows.getSeason(this, showId, seasonNumber); }
  listSeasons(showId: string) { return shows.listSeasons(this, showId); }

  // ---- Episodes ----------------------------------------------------------

  saveEpisode(episode: Parameters<typeof shows.saveEpisode>[1]) { return shows.saveEpisode(this, episode); }
  syncEpisodes(showId: string, episodes: Parameters<typeof shows.syncEpisodes>[2]) { return shows.syncEpisodes(this, showId, episodes); }
  getEpisode(showId: string, seasonNumber: number, episodeNumber: number) { return shows.getEpisode(this, showId, seasonNumber, episodeNumber); }
  listEpisodes(showId: string, seasonNumber: number) { return shows.listEpisodes(this, showId, seasonNumber); }
  listAllEpisodes(showId: string) { return shows.listAllEpisodes(this, showId); }
  listUpcomingEpisodes(futureDays: number, pastDays?: number) { return shows.listUpcomingEpisodes(this, futureDays, pastDays); }
  listUnscheduledEpisodes() { return shows.listUnscheduledEpisodes(this); }
  listMissingEpisodes() { return shows.listMissingEpisodes(this); }
  setTracked(showId: string, seasonNumber: number, episodeNumber: number, tracked: boolean) { return shows.setTracked(this, showId, seasonNumber, episodeNumber, tracked); }
  updateEpisodeFilePath(showId: string, seasonNumber: number, episodeNumber: number, filePath: string) { return shows.updateEpisodeFilePath(this, showId, seasonNumber, episodeNumber, filePath); }
  listShowEpisodes(showId: string) { return shows.listShowEpisodes(this, showId); }
  updateEpisodeSearchMode(showId: string, seasonNumber: number, episodeNumber: number, mode: string) { return shows.updateEpisodeSearchMode(this, showId, seasonNumber, episodeNumber, mode); }
  updateEpisodeAirWindow(showId: string, seasonNumber: number, episodeNumber: number, updates: Parameters<typeof shows.updateEpisodeAirWindow>[4]) { return shows.updateEpisodeAirWindow(this, showId, seasonNumber, episodeNumber, updates); }
  setShowReleaseDelay(showId: string, delayMinutes: number) { return shows.setShowReleaseDelay(this, showId, delayMinutes); }

  // ---- Show misc ---------------------------------------------------------

  getShowRootFolder(showId: string) { return shows.getShowRootFolder(this, showId); }
  updateShow(showId: string, updates: Parameters<typeof shows.updateShow>[2]) { return shows.updateShow(this, showId, updates); }
  renameShow(showId: string, newTitle: string) { return shows.renameShow(this, showId, newTitle); }
  hasUserTitleOverride(showId: string) { return shows.hasUserTitleOverride(this, showId); }
  setShowTracking(showId: string, tracked: boolean) { return shows.setShowTracking(this, showId, tracked); }
  bulkUpdateShows(ids: string[], updates: Parameters<typeof shows.bulkUpdateShows>[2]) { return shows.bulkUpdateShows(this, ids, updates); }
  removeShow(showId: string) { return shows.removeShow(this, showId); }
  removeShows(ids: string[]) { return shows.removeShows(this, ids); }

  // ---- Show Artworks -----------------------------------------------------

  saveShowArtwork(showId: string, type: number, imageUrl: string, width?: number, height?: number, thumbnail?: string, data?: Uint8Array, contentType?: string, providerType?: string) { return shows.saveShowArtwork(this, showId, type, imageUrl, width, height, thumbnail, data, contentType, providerType); }
  getShowArtworks(showId: string, type?: number, providerType?: string) { return shows.getShowArtworks(this, showId, type, providerType); }
  getShowArtworkMeta(showId: string, type?: number) { return shows.getShowArtworkMeta(this, showId, type); }
  getShowArtworkBlob(id: number) { return shows.getShowArtworkBlob(this, id); }
  clearShowArtworkImage(id: number) { return shows.clearShowArtworkImage(this, id); }
  gcArtworkFiles(paths: (string | null | undefined)[]) { return shows.gcArtworkFiles(this, paths); }
  updateShowArtworkData(showId: string, type: number, data: Uint8Array, providerType?: string) { return shows.updateShowArtworkData(this, showId, type, data, providerType); }

  // ---- Processed files ---------------------------------------------------

  logProcessedFile(hash: string, original: string, final: string) { return system.logProcessedFile(this, hash, original, final); }
  isProcessed(hash: string) { return system.isProcessed(this, hash); }
  removeProcessedFile(hash: string) { return system.removeProcessedFile(this, hash); }

  // ---- Grabbed releases (series -> release -> episode tracking) -----------

  recordGrabbedRelease(input: Parameters<typeof grabs.recordGrabbedRelease>[1]) { return grabs.recordGrabbedRelease(this, input); }
  findGrabbedReleaseForEpisode(season: number, episode: number, withinDays?: number) { return grabs.findGrabbedReleaseForEpisode(this, season, episode, withinDays); }
  findMostRecentGrabForShow(showId: string, withinDays?: number) { return grabs.findMostRecentGrabForShow(this, showId, withinDays); }
  findGrabbedReleaseForShowEpisode(showId: string, season: number, episode: number, withinDays?: number) { return grabs.findGrabbedReleaseForShowEpisode(this, showId, season, episode, withinDays); }
  listGrabbedReleasesForShow(showId: string, limit?: number) { return grabs.listGrabbedReleasesForShow(this, showId, limit); }
  listEpisodesDueForGrab(nowIso: string, grabCooldownIso: string, limit: number) { return grabs.listEpisodesDueForGrab(this, nowIso, grabCooldownIso, limit); }
  recordEpisodeSearchMiss(showId: string, season: number, episode: number, nowIso?: string) { return grabs.recordEpisodeSearchMiss(this, showId, season, episode, nowIso); }
  getGrab(id: number) { return grabs.getGrab(this, id); }
  markGrabStatus(id: number, status: Parameters<typeof grabs.markGrabStatus>[2]) { return grabs.markGrabStatus(this, id, status); }
  markGrabFailed(id: number, reason: string, nowIso?: string) { return grabs.markGrabFailed(this, id, reason, nowIso); }
  findOpenGrabsForRelease(release: { title: string; infoHash?: string | null }, withinDays?: number) { return grabs.findOpenGrabsForRelease(this, release, withinDays); }
  listRecentGrabs(limit?: number) { return grabs.listRecentGrabs(this, limit); }

  // ---- Release blocklist ---------------------------------------------------

  addToBlocklist(input: Parameters<typeof blocklist.addToBlocklist>[1]) { return blocklist.addToBlocklist(this, input); }
  isBlocklisted(showId: string, release: Parameters<typeof blocklist.isBlocklisted>[2]) { return blocklist.isBlocklisted(this, showId, release); }
  listBlocklist(limit?: number) { return blocklist.listBlocklist(this, limit); }
  removeFromBlocklist(id: number) { return blocklist.removeFromBlocklist(this, id); }
  clearBlocklist() { return blocklist.clearBlocklist(this); }
  listEpisodesWithFiles(grabCooldownIso: string) { return grabs.listEpisodesWithFiles(this, grabCooldownIso); }
  getSeasonAirStats(showId: string, season: number, nowIso: string) { return grabs.getSeasonAirStats(this, showId, season, nowIso); }
  listMissingEpisodeNumbers(showId: string, season: number) { return grabs.listMissingEpisodeNumbers(this, showId, season); }
  listGrabbedTitlesForEpisode(showId: string, season: number, episode: number) { return grabs.listGrabbedTitlesForEpisode(this, showId, season, episode); }

  // ---- Episode files (provenance) ----------------------------------------

  recordEpisodeFile(input: Parameters<typeof episodeFiles.recordEpisodeFile>[1]) { return episodeFiles.recordEpisodeFile(this, input); }
  getCurrentEpisodeFile(showId: string, seasonNumber: number, episodeNumber: number) { return episodeFiles.getCurrentEpisodeFile(this, showId, seasonNumber, episodeNumber); }
  listEpisodeFilesByShow(showId: string) { return episodeFiles.listEpisodeFilesByShow(this, showId); }
  getCurrentEpisodeFilesByShow(showId: string) { return episodeFiles.getCurrentEpisodeFilesByShow(this, showId); }
  getCurrentEpisodeFilesForShows(showIds: string[]) { return episodeFiles.getCurrentEpisodeFilesForShows(this, showIds); }
  listAllCurrentEpisodeFiles() { return episodeFiles.listAllCurrentEpisodeFiles(this); }
  backfillEpisodeFiles() { return episodeFiles.backfillEpisodeFiles(this); }
  updateEpisodeFileMedia(rowId: number, media: Parameters<typeof episodeFiles.updateEpisodeFileMedia>[2]) { return episodeFiles.updateEpisodeFileMedia(this, rowId, media); }
  updateEpisodeFileRowPath(rowId: number, filePath: string) { return episodeFiles.updateEpisodeFileRowPath(this, rowId, filePath); }
  listUnprobedEpisodeFiles() { return episodeFiles.listUnprobedEpisodeFiles(this); }
  pruneSupersededEpisodeFiles() { return episodeFiles.pruneSupersededEpisodeFiles(this); }
  getMovieFile(showId: string) { return episodeFiles.getMovieFile(this, showId); }
  recordMovieFile(input: Parameters<typeof episodeFiles.recordMovieFile>[1]) { return episodeFiles.recordMovieFile(this, input); }

  // ---- Episode mapping (anime season-splits, issues-tracking.md #4) --------

  getEpisodeMappingConfig(showId: string) { return mappings.getMappingConfig(this, showId); }
  setEpisodeMappingConfig(showId: string, cfg: Parameters<typeof mappings.setMappingConfig>[2]) { return mappings.setMappingConfig(this, showId, cfg); }
  isEpisodeMappingEnabled(showId: string) { return mappings.isMappingEnabled(this, showId); }
  listEpisodeMappings(showId: string) { return mappings.listEpisodeMappings(this, showId); }
  findSceneMapping(showId: string, season: number, episode: number) { return mappings.findSceneMapping(this, showId, season, episode); }
  findAbsoluteMapping(showId: string, absolute: number) { return mappings.findAbsoluteMapping(this, showId, absolute); }
  findTargetMapping(showId: string, season: number, episode: number) { return mappings.findTargetMapping(this, showId, season, episode); }
  findTargetAbsoluteMapping(showId: string, absolute: number) { return mappings.findTargetAbsoluteMapping(this, showId, absolute); }
  listSceneSeasonsForTarget(showId: string, targetSeason: number) { return mappings.listSceneSeasonsForTarget(this, showId, targetSeason); }
  replaceThexemMappings(showId: string, tvdbId: string, rows: Parameters<typeof mappings.replaceThexemMappings>[3]) { return mappings.replaceThexemMappings(this, showId, tvdbId, rows); }
  lockMappingRow(showId: string, rowId: number, target: Parameters<typeof mappings.lockMappingRow>[3]) { return mappings.lockMappingRow(this, showId, rowId, target); }
  setMappingRowLock(showId: string, rowId: number, locked: boolean) { return mappings.setMappingRowLock(this, showId, rowId, locked); }
  deleteEpisodeMappingsForShow(showId: string) { return mappings.deleteMappingsForShow(this, showId); }
  deleteEpisodeMappingConfigForShow(showId: string) { return mappings.deleteMappingConfigForShow(this, showId); }

  // ---- Metadata cache ----------------------------------------------------

  getCache<T = any>(key: string) { return system.getCache<T>(this, key); }
  setCache(key: string, data: any, ttlMs?: number) { return system.setCache(this, key, data, ttlMs); }
  removeCacheKey(key: string) { return system.removeCacheKey(this, key); }

  // ---- Tasks -------------------------------------------------------------

  saveTask(task: Parameters<typeof system.saveTask>[1]) { return system.saveTask(this, task); }
  listTasks() { return system.listTasks(this); }
  deleteTask(name: string) { return system.deleteTask(this, name); }
  updateTaskExecution(name: string, durationMs: number, nextExecution: string) { return system.updateTaskExecution(this, name, durationMs, nextExecution); }

  // ---- Audit logs --------------------------------------------------------

  logEvent(event: Parameters<typeof system.logEvent>[1]) { return system.logEvent(this, event); }
  ensureCleanupIndexes() { return system.ensureCleanupIndexes(this); }
  purgeOldScanLogs(beforeIso: string, limit?: number) { return system.purgeOldScanLogs(this, beforeIso, limit); }
  listRecentEvents(limit?: number) { return system.listRecentEvents(this, limit); }
  cleanupOldLogs(beforeDate: string) { return system.cleanupOldLogs(this, beforeDate); }
  cleanupExpiredCache() { return system.cleanupExpiredCache(this); }
  getCacheStats() { return system.getCacheStats(this); }

  // ---- Pipeline event log -------------------------------------------------

  logPipelineEvent(event: Parameters<typeof pipeline.logPipelineEvent>[1]) {
    const res = pipeline.logPipelineEvent(this, event);
    // In-app notifications are derived from these rows; fan out to connect targets.
    emitConnectSignal({ source: 'pipeline', ...event });
    return res;
  }
  listPipelineEvents(filter: Parameters<typeof pipeline.listPipelineEvents>[1]) { return pipeline.listPipelineEvents(this, filter); }
  getLatestPipelineEvent(showId: string, seasonNumber?: number, episodeNumber?: number) { return pipeline.getLatestPipelineEvent(this, showId, seasonNumber, episodeNumber); }
  hasRecentPipelineEvent(showId: string, seasonNumber: number | null, episodeNumber: number | null, eventType: string, sinceIso: string) { return pipeline.hasRecentPipelineEvent(this, showId, seasonNumber, episodeNumber, eventType, sinceIso); }
  listRecentPipelineEvents(limit?: number) { return pipeline.listRecentPipelineEvents(this, limit); }
  cleanupOldPipelineEvents(beforeDate: string) { return pipeline.cleanupOldPipelineEvents(this, beforeDate); }
  getPipelineEventStats() { return pipeline.getPipelineEventStats(this); }
  getHourlyPipelineEventCounts(hours?: number) { return pipeline.getHourlyPipelineEventCounts(this, hours); }
  getNoisiestShows(limit?: number) { return pipeline.getNoisiestShows(this, limit); }
  setEpisodeStatus(target: episodeStatus.StatusTarget, update: episodeStatus.StatusUpdate, nowIso?: string) { return episodeStatus.setEpisodeStatus(this, target, update, nowIso); }
  getEpisodeStatus(target: episodeStatus.StatusTarget) { return episodeStatus.getEpisodeStatus(this, target); }
  setStatusForRelease(releaseTitle: string, update: episodeStatus.StatusUpdate, withinHours?: number) { return episodeStatus.setStatusForRelease(this, releaseTitle, update, withinHours); }
  listHistory(filter: Parameters<typeof pipeline.listHistory>[1]) { return pipeline.listHistory(this, filter); }

  // ---- Analytics / DB usage -----------------------------------------------

  getTableStats() { return analytics.getTableStats(this); }

  // ---- System health snapshot ---------------------------------------------

  upsertHealthStatus(input: Parameters<typeof health.upsertHealthStatus>[1]) {
    const res = health.upsertHealthStatus(this, input);
    emitConnectSignal({ source: 'health', ...input });
    return res;
  }
  removeHealthComponent(componentType: Parameters<typeof health.removeHealthComponent>[1], componentId: string) { return health.removeHealthComponent(this, componentType, componentId); }
  getHealthSnapshot() { return health.getHealthSnapshot(this); }

  // ---- Show Profiles -----------------------------------------------------

  listShowProfiles() { return config.listShowProfiles(this); }
  saveShowProfile(id: string, name: string, rootFolderPath: string) { return config.saveShowProfile(this, id, name, rootFolderPath); }
  removeShowProfile(id: string) { return config.removeShowProfile(this, id); }
  getShowProfileRootFolder(profileId: string) { return config.getShowProfileRootFolder(this, profileId); }

  // ---- Library Types (design-brief-platform-ux-systems.md §1) ------------

  listLibraryTypes() { return config.listLibraryTypes(this); }
  getLibraryType(id: string) { return config.getLibraryType(this, id); }
  saveLibraryType(t: Parameters<typeof config.saveLibraryType>[1]) { return config.saveLibraryType(this, t); }
  removeLibraryType(id: string) { return config.removeLibraryType(this, id); }
  resolveLibraryTypeId(id: string | null | undefined) { return config.resolveLibraryTypeId(this, id); }

  // ---- Settings ----------------------------------------------------------

  getSetting(key: string) { return config.getSetting(this, key); }
  setSetting(key: string, value: any) { return config.setSetting(this, key, value); }
  removeSetting(key: string) { return config.removeSetting(this, key); }
  getAllSettings() { return config.getAllSettings(this); }

  // ---- Quality -----------------------------------------------------------

  saveQuality(q: Parameters<typeof config.saveQuality>[1]) { return config.saveQuality(this, q); }
  getQuality(id: string) { return config.getQuality(this, id); }
  removeQuality(id: string) { return config.removeQuality(this, id); }
  listQualities() { return config.listQualities(this); }

  // ---- Quality Profiles --------------------------------------------------

  saveProfile(p: Parameters<typeof config.saveProfile>[1]) { return config.saveProfile(this, p); }
  resolveProfileId(id: string | null | undefined) { return config.resolveProfileId(this, id); }
  getProfile(id: string) { return config.getProfile(this, id); }
  removeProfile(id: string) { return config.removeProfile(this, id); }
  listProfiles() { return config.listProfiles(this); }

  // ---- Custom Formats ----------------------------------------------------

  saveCustomFormat(f: Parameters<typeof config.saveCustomFormat>[1]) { return config.saveCustomFormat(this, f); }
  getCustomFormat(id: string) { return config.getCustomFormat(this, id); }
  removeCustomFormat(id: string) { return config.removeCustomFormat(this, id); }
  listCustomFormats() { return config.listCustomFormats(this); }

  // ---- Profile-Format mapping --------------------------------------------

  addProfileFormat(profileId: string, formatId: string, type?: 'bonus' | 'required' | 'forbidden') { return config.addProfileFormat(this, profileId, formatId, type); }
  removeProfileFormat(profileId: string, formatId: string) { return config.removeProfileFormat(this, profileId, formatId); }
  getProfileFormats(profileId: string) { return config.getProfileFormats(this, profileId); }

  // ---- Profile-Quality mapping -------------------------------------------

  addProfileQuality(profileId: string, qualityId: string) { return config.addProfileQuality(this, profileId, qualityId); }
  removeProfileQuality(profileId: string, qualityId: string) { return config.removeProfileQuality(this, profileId, qualityId); }
  getProfileQualities(profileId: string) { return config.getProfileQualities(this, profileId); }
}

export const db = new DatabaseManager();
