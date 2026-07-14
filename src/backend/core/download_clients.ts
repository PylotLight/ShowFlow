import { watch } from 'node:fs';
import { rename, mkdir, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Oracle } from '../parser/oracle';
import { db, type Config } from '../db';
import type { ProviderType } from '../providers/factory';
import { debugLog } from './debug';
import { qualityEngine } from './quality_engine';
import { TorboxService } from '../providers/torbox/services';
import { existsSync } from 'node:fs';

export interface DownloadClient {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class BlackholeClient implements DownloadClient {
  name = 'Blackhole';
  private oracle = new Oracle();

  // Files actively inside handleFile() right now (used both for dedupe and
  // for the dashboard's "processing" indicator).
  private processingQueue: Set<string> = new Set();

  // A real FIFO queue: fs.watch events (and scans) enqueue filenames here
  // instead of calling handleFile() directly, and a single worker loop
  // drains it one file at a time. This replaces the old design where every
  // fs.watch 'rename' event spawned its own concurrent, unordered
  // handleFile() call - fine for one file at a time, but for a bulk copy of
  // 20 files it meant unbounded parallel provider lookups (racing TVDB auth,
  // hammering rate limits) with no defined order and no way to tell how
  // much work was actually left.
  private pendingQueue: string[] = [];
  private pendingSet: Set<string> = new Set();
  private queueWorkerRunning = false;

  private watchHandle: any = null;
  private watchFolder: string | null = null;

  // Safety net: fs.watch (FSEvents on macOS in particular) can silently drop
  // or coalesce events when many files land in a folder at once, e.g. a
  // bulk `cp`. Without this, any file whose event got missed would sit
  // forgotten until someone noticed and hit "Rescan Watch Folder" manually,
  // or restarted the server. A periodic re-scan costs one readdir() and
  // silently requeues anything that isn't already queued/processing/done.
  private static readonly SAFETY_RESCAN_INTERVAL_MS = 3 * 60 * 1000;
  private safetyRescanHandle: ReturnType<typeof setInterval> | null = null;

  // OS/editor junk that shows up in watch folders but is never a real
  // download - these should be silently cleaned up, not sent to the
  // metadata resolver (which would just fail and log a spurious error).
  private static readonly IGNORED_FILENAMES = new Set([
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '.localized',
  ]);

  constructor(private config: Config) { }

  private isIgnoredFile(filename: string): boolean {
    const base = path.basename(filename);
    if (BlackholeClient.IGNORED_FILENAMES.has(base)) return true;
    // Any dotfile (hidden file) - e.g. ._AppleDouble resource forks, .swp, etc.
    if (base.startsWith('.')) return true;
    return false;
  }

  async start() {
    const folder = this.config.downloadClient?.blackhole?.watchFolder;

    if (!folder) {
      console.log(`[${this.name}] No watch folder configured. Skipping.`);
      return;
    }

    this.watchFolder = folder;

    console.log(`[${this.name}] Watching folder: ${folder}`);
    if (this.config.dryRun) {
      console.log(`[${this.name}] Dry-run mode: files will be resolved but NOT moved.`);
    }

    // Scan existing files on startup
    await this.scanExistingFiles(folder);

    this.watchHandle = watch(folder, (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        this.enqueue(folder, filename);
      }
    });

    this.safetyRescanHandle = setInterval(() => {
      if (this.watchFolder) {
        this.scanExistingFiles(this.watchFolder, { silent: true }).catch(() => {});
      }
    }, BlackholeClient.SAFETY_RESCAN_INTERVAL_MS);
  }

  async stop() {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = null;
    }
    if (this.safetyRescanHandle) {
      clearInterval(this.safetyRescanHandle);
      this.safetyRescanHandle = null;
    }
    this.watchFolder = null;
  }

  async scanExistingFiles(folder: string, opts: { silent?: boolean } = {}) {
    try {
      if (!opts.silent) {
        console.log(`[${this.name}] Scanning existing files in: ${folder}`);
        db.logEvent({ type: 'scan', entityType: 'system', message: `Starting scan of watch folder: ${folder}` });
      }

      const files = await readdir(folder);
      let queuedCount = 0;
      let skippedCount = 0;

      for (const filename of files) {
        if (this.isIgnoredFile(filename)) {
          skippedCount++;
          continue;
        }

        const fullPath = path.join(folder, filename);
        if (this.pendingSet.has(fullPath) || this.processingQueue.has(fullPath)) {
          // Already queued or actively being handled - a periodic safety
          // rescan should never pile up duplicate queue entries for a file
          // that's simply still working its way through.
          continue;
        }

        this.enqueue(folder, filename);
        queuedCount++;
      }

      // On a silent (periodic safety-net) pass, only log anything if it
      // actually found something fs.watch had missed - otherwise every scan
      // would spam the activity feed every 3 minutes for no reason.
      if (!opts.silent || queuedCount > 0) {
        console.log(`[${this.name}] Scan complete. Queued ${queuedCount} file(s), skipped ${skippedCount}.`);
        db.logEvent({
          type: 'scan',
          entityType: 'system',
          message: `Watch folder scan complete: ${queuedCount} queued, ${skippedCount} skipped`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${this.name}] Error scanning existing files:`, error);
      db.logEvent({ type: 'error', entityType: 'system', message: `Watch folder scan failed: ${message}` });
    }
  }

  /**
   * Adds a filename to the processing queue if it isn't already waiting or
   * actively being handled, and kicks off the worker loop if it isn't
   * already running. Safe to call redundantly (e.g. from both a fs.watch
   * event and an overlapping safety-net scan).
   */
  private enqueue(folder: string, filename: string) {
    const fullPath = path.join(folder, filename);

    if (this.pendingSet.has(fullPath) || this.processingQueue.has(fullPath)) {
      return;
    }

    this.pendingSet.add(fullPath);
    this.pendingQueue.push(filename);

    void this.runQueue(folder);
  }

  /**
   * Drains the pending queue one file at a time. Deliberately sequential
   * rather than concurrent: parallel provider lookups on a bulk import
   * would race TVDB's token auth and multiply how fast rate limits get hit,
   * for no real speed benefit on what's fundamentally an I/O + network-bound
   * task. A failure on one file (handleFile catches and logs its own
   * errors) must never stop the rest of the queue from draining.
   */
  private async runQueue(folder: string) {
    if (this.queueWorkerRunning) return;
    this.queueWorkerRunning = true;

    try {
      while (this.pendingQueue.length > 0) {
        const filename = this.pendingQueue.shift()!;
        const fullPath = path.join(folder, filename);
        this.pendingSet.delete(fullPath);

        await this.handleFile(folder, filename);
      }
    } finally {
      this.queueWorkerRunning = false;
    }
  }

  getWatchFolder(): string | null {
    return this.watchFolder;
  }

  getProcessingFiles(): string[] {
    // Both the file actively inside handleFile() right now and everything
    // still waiting its turn, so the dashboard shows the real backlog depth
    // instead of just whichever single file happens to be mid-flight.
    const active = Array.from(this.processingQueue).map(p => path.basename(p));
    return [...active, ...this.pendingQueue];
  }

  /**
   * Lists all files currently sitting in the watch folder, resolving each
   * one's metadata (show, season, episode) so the manual-import UI can
   * display a table of pending files with their resolution status.
   */
  async listWatchFolderFiles(): Promise<{
    filename: string;
    fullPath: string;
    show?: string;
    showId?: string;
    season?: number;
    episodes?: number[];
    existingFile?: string;
    resolved: boolean;
    error?: string;
  }[]> {
    const folder = this.watchFolder;
    if (!folder) return [];

    const results: {
      filename: string;
      fullPath: string;
      show?: string;
      showId?: string;
      season?: number;
      episodes?: number[];
      existingFile?: string;
      resolved: boolean;
      error?: string;
    }[] = [];

    try {
      const files = await readdir(folder);
      for (const filename of files) {
        if (this.isIgnoredFile(filename)) continue;
        const fullPath = path.join(folder, filename);

        const entry: any = { filename, fullPath, resolved: false };
        try {
          const result = await this.oracle.resolve(
            filename,
            this.config.defaultProvider as any,
            this.config as any,
          );
          if (result) {
            entry.show = result.show.title;
            entry.showId = result.show.id;
            entry.season = result.episodes[0]?.season;
            entry.episodes = result.episodes.map((e: any) => e.episode);
            entry.resolved = true;

            const existingShow = db.getShowByProvider(result.show.provider, result.show.id);
            if (existingShow && entry.season != null && entry.episodes?.[0] != null) {
              const existingEp = db.getEpisode(existingShow.id, entry.season, entry.episodes[0]);
              if (existingEp?.file_path) {
                entry.existingFile = path.basename(existingEp.file_path);
              }
            }
          }
        } catch (e) {
          entry.error = e instanceof Error ? e.message : String(e);
        }

        results.push(entry);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${this.name}] Error listing watch folder:`, message);
    }

    return results;
  }

  async countWatchFolderFiles(): Promise<number> {
    const folder = this.watchFolder;
    if (!folder) return 0;
    try {
      const files = await readdir(folder);
      return files.filter(f => !this.isIgnoredFile(f)).length;
    } catch {
      return 0;
    }
  }

  async deleteFile(filename: string): Promise<{ ok: boolean; message: string }> {
    const folder = this.watchFolder;
    if (!folder) {
      return { ok: false, message: 'Watch folder is not configured.' };
    }
    const fullPath = path.join(folder, filename);
    try {
      await unlink(fullPath);
      console.log(`[${this.name}] Deleted ${filename} from watch folder.`);
      db.logEvent({ type: 'delete', entityType: 'file', message: `Deleted ${filename} from watch folder` });
      return { ok: true, message: `Deleted "${filename}"` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Failed to delete "${filename}": ${message}` };
    }
  }

  /**
   * Force-imports a file from the watch folder, bypassing the upgrade check.
   */
  async forceImport(filename: string): Promise<{ ok: boolean; message: string }> {
    const folder = this.watchFolder;
    if (!folder) {
      return { ok: false, message: 'Watch folder is not configured.' };
    }

    const fullPath = path.join(folder, filename);
    try {
      await stat(fullPath);
    } catch {
      return { ok: false, message: `File "${filename}" no longer exists in the watch folder.` };
    }

    try {
      await this.handleFile(folder, filename, { force: true });
      return { ok: true, message: `Imported "${filename}"` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Failed to import "${filename}": ${message}` };
    }
  }

  private async handleFile(folder: string, filename: string, opts?: { force?: boolean }) {
    const fullPath = path.join(folder, filename);

    if (this.isIgnoredFile(filename)) {
      debugLog(`Ignoring junk file: ${filename}`);
      try {
        await unlink(fullPath);
      } catch {
        // Already gone, or we don't have permission to remove it - either
        // way there's nothing useful to do, so fail silently.
      }
      return;
    }

    // fs.watch's 'rename' event fires both when a file appears in the
    // folder AND when it disappears - including when *we* move it out
    // after a successful import. Without this check, our own successful
    // move immediately re-triggers handleFile() for a path that no longer
    // exists: waitForStableFile() would then spend a full 5 minutes calling
    // stat() on a missing file before giving up with a misleading "failed
    // to stabilize" error, even though the file was already imported fine
    // moments earlier. Bail out immediately and silently instead.
    try {
      await stat(fullPath);
    } catch {
      debugLog('Ignoring rename event for a file that no longer exists (likely our own move-out, or an external delete)', { filename, fullPath });
      return;
    }

    if (this.processingQueue.has(fullPath)) return;
    this.processingQueue.add(fullPath);

    try {
      const stable = await this.waitForStableFile(fullPath);
      if (!stable) {
        db.logEvent({ type: 'error', entityType: 'file', message: `File ${filename} failed to stabilize for processing` });
        return;
      }

      console.log(`[${this.name}] Processing file: ${filename}`);
      debugLog('Processing file', { filename, fullPath });

      const hash = await this.hashFile(fullPath);
      if (db.isProcessed(hash)) {
        if (opts?.force) {
          console.log(`[${this.name}] Force-importing ${filename} (overriding duplicate check).`);
          db.removeProcessedFile(hash);
        } else {
          console.log(`[${this.name}] Skipping duplicate: ${filename}`);
          db.logEvent({ type: 'skip', entityType: 'file', message: `Skipped duplicate: ${filename}` });
          return;
        }
      }

      const result = await this.oracle.resolve(filename, this.config.defaultProvider as ProviderType, this.config);

      debugLog('Oracle resolve result', { filename, result });
      if (!result) {
        const diagnostics = this.oracle.getDiagnostics();
        const parsed = diagnostics.parsed;

        const matchedAttempt = diagnostics.providerAttempts.find(a => a.matchedTitle);

        let errorMessage = '';
        if (matchedAttempt) {
          errorMessage = `Found show "${matchedAttempt.matchedTitle}" on ${matchedAttempt.provider}, but could not resolve the requested episode.`;
        } else if (parsed?.show) {
          errorMessage = `Could not find show "${parsed.show}" on any configured provider.`;
        } else {
          errorMessage = `Could not parse show name from filename "${filename}".`;
        }

        console.error(`[${this.name}] Could not resolve metadata for ${filename}`);
        console.error(`[${this.name}] Reason: ${errorMessage}`);
        console.error(`[${this.name}] Parsed filename:`, parsed ?? '(parsing failed - no show/season/episode extracted)');

        if (parsed?.show) {
          for (const attempt of diagnostics.providerAttempts) {
            if (attempt.matchedTitle) {
              const errs = attempt.episodeErrors.length > 0
                ? attempt.episodeErrors.join('; ')
                : '(no episode data returned)';
              console.error(`[${this.name}]   ${attempt.provider}: matched "${attempt.matchedTitle}" but episode lookup failed - ${errs}`);
            } else if (attempt.candidateCount === 0) {
              console.error(`[${this.name}]   ${attempt.provider}: no results for "${attempt.strategies.join('", "')}"`);
            } else {
              const names = attempt.candidates.map(c => c.title).join(', ');
              console.error(`[${this.name}]   ${attempt.provider}: ${attempt.candidateCount} result(s), none matched confidently. Closest: ${names}`);
            }
          }
        }

        console.error(`[${this.name}] Parse details:`, {
          filename,
          folder,
          provider: this.config.defaultProvider,
          timestamp: new Date().toISOString()
        });

        if (!matchedAttempt && parsed?.show) {
          const bestAttempt = diagnostics.providerAttempts.find(a => a.candidateCount > 0);
          if (bestAttempt) {
            const similarShows = bestAttempt.candidates.slice(0, 3).map(s => s.title).join(', ');
            errorMessage += ` Closest matches on ${bestAttempt.provider}: ${similarShows}.`;
          } else {
            errorMessage += ` No matching shows found on tmdb, tvdb, or anilist.`;
          }
        }

        db.logEvent({
          type: 'error',
          entityType: 'file',
          message: `Metadata resolution failed for ${filename}: ${errorMessage}`
        });
        return;
      }

      const { show, episodes, proposedPath } = result;

      // Log successful resolution with provider information
      debugLog('Show resolved successfully', {
        filename,
        showTitle: show.title,
        provider: show.provider,
        showId: show.id
      });

      // Resolve UUID: check if show already exists via its provider link
      let existingShow = db.getShowByProvider(show.provider, show.id);
      let showId: string;

      if (existingShow) {
        showId = existingShow.id;
      } else {
        /*
         * Imported shows need a physical library destination. `profile` is a
         * quality profile, while `showProfileId` selects a root-folder preset.
         */
        const showProfiles = db.listShowProfiles();

        if (showProfiles.length === 0) {
          const message =
            `No show root-folder profiles are configured; cannot import ` +
            `"${show.title}".`;

          console.error(`[${this.name}] ${message}`);
          db.logEvent({
            type: 'error',
            entityType: 'file',
            message,
          });
          return;
        }

        /*
         * Pick a root-folder profile for the new show. The user can
         * configure a default via the `defaultShowProfileId` setting;
         * otherwise we take the first available profile.
         */
        const configuredDefault = db.getSetting('defaultShowProfileId');
        let showProfileId =
          typeof configuredDefault === 'string' && configuredDefault.trim()
            ? configuredDefault
            : showProfiles[0]?.id;

        if (!showProfileId) {
          const message =
            `No root-folder profile selected for "${show.title}". ` +
            `Configure a default profile or create at least one show profile.`;

          console.error(`[${this.name}] ${message}`);
          db.logEvent({ type: 'error', entityType: 'file', message });
          return;
        }

        showId = crypto.randomUUID();

        db.saveShow({
          uuid: showId,
          providerId: show.id,
          type: show.provider,
          title: show.title,
          originalTitle: show.originalTitle,
          romanizedTitle: show.romanizedTitle,
          year: show.year,
          profile: 'standard',
          showProfileId,
          metadata: show.metadata,
          config: {},
        });
      }


      const rootFolder = db.getShowRootFolder(showId);
      if (!rootFolder) {
        console.error(`[${this.name}] No root folder configured for ${show.title}. Make sure a profile with a root folder is assigned. Skipping.`);
        db.logEvent({
          type: 'error',
          entityType: 'file',
          message: `No root folder configured for ${show.title}. File ${filename} skipped.`
        });
        return;
      }
      const finalPath = path.join(rootFolder, proposedPath);

      if (this.config.dryRun) {
        console.log(`[${this.name}] [dry-run] Would move ${filename} -> ${finalPath}`);
        db.logEvent({ type: 'dryrun', entityType: 'file', message: `[dry-run] Would import ${filename} for ${show.title}` });
        return;
      }

      // ---- Upgrade & Format Logic ---------------------------------------
      // We check if this file is an upgrade over any existing file for the same episode.
      const firstEp = episodes[0];
      if (firstEp) {
        const existingEp = db.getEpisode(showId, firstEp.season, firstEp.episode);
        if (existingEp && existingEp.file_path) {
          const existingFilename = path.basename(existingEp.file_path);
          const profileId = db.getShow(showId)?.profile || 'standard';

          if (opts?.force) {
            console.log(`[${this.name}] Force-importing ${filename} (skipping upgrade check over ${existingFilename}).`);
            // Delete old file when force-importing a replacement
            try {
              await unlink(existingEp.file_path);
            } catch (e) {
              console.warn(`[${this.name}] Failed to remove old file ${existingEp.file_path}:`, e);
            }
            db.logEvent({
              type: 'manual-import',
              entityType: 'file',
              message: `Force-imported ${filename} over ${existingFilename} for ${show.title}`
            });
          } else if (!qualityEngine.shouldUpgrade(existingFilename, filename, profileId)) {
            console.log(`[${this.name}] New file ${filename} is not an upgrade over ${existingFilename}. Skipping. File remains in watch folder for manual review.`);
            db.logEvent({
              type: 'skip',
              entityType: 'file',
              message: `${filename} is not an upgrade over existing ${existingFilename}. Skipping.`
            });
            return;
          } else {
            console.log(`[${this.name}] New file ${filename} is an upgrade over ${existingFilename}. Replacing.`);
            db.logEvent({
              type: 'upgrade',
              entityType: 'file',
              message: `Upgrading ${existingFilename} to ${filename} for ${show.title}`
            });
            try {
              await unlink(existingEp.file_path);
            } catch (e) {
              console.warn(`[${this.name}] Failed to remove old file ${existingEp.file_path}:`, e);
              db.logEvent({
                type: 'error',
                entityType: 'file',
                message: `Failed to remove old file ${existingEp.file_path} during upgrade`
              });
            }
          }
        }
      }

      await mkdir(path.dirname(finalPath), { recursive: true });

      const movedTo = await this.moveFile(fullPath, finalPath, this.config.onCollision);
      if (movedTo === null) return;

      console.log(`[${this.name}] Moved ${filename} -> ${movedTo}`);
      debugLog('File moved successfully', { filename, movedTo });
      db.logProcessedFile(hash, fullPath, movedTo);
      db.logEvent({
        type: 'grab',
        entityType: 'episode',
        entityId: showId,
        message: `Imported ${filename} for ${show.title}`,
        metadata: { movedTo, episodes: episodes.map((e) => ({ season: e.season, episode: e.episode })) },
      });

      const firstEpisode = episodes[0];
      if (firstEpisode) {
        const seasonFolderFormat = this.config.seasonFolderFormat || 'Season {season}';
        const seasonName = seasonFolderFormat
          .replace('{season:02}', String(firstEpisode.season).padStart(2, '0'))
          .replace('{season}', String(firstEpisode.season));
        db.saveSeason(showId, firstEpisode.season, seasonName);
      }

      for (const ep of episodes) {
        db.saveEpisode({
          showId,
          seasonNumber: ep.season,
          episodeNumber: ep.episode,
          absoluteNumber: ep.absoluteNumber,
          title: ep.title,
          filePath: movedTo,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${this.name}] Error processing ${filename}:`, e);
      db.logEvent({ type: 'error', entityType: 'file', message: `Error processing ${filename}: ${message}` });
    } finally {
      this.processingQueue.delete(fullPath);
    }
  }

  private async waitForStableFile(
    filePath: string,
    requiredStableChecks = 3,
    intervalMs = 500,
    maxWaitMs = 5 * 60 * 1000
  ): Promise<boolean> {
    let lastSize = -1;
    let stableCount = 0;
    const start = Date.now();

    while (stableCount < requiredStableChecks) {
      if (Date.now() - start > maxWaitMs) {
        console.warn(`[${this.name}] Gave up waiting for ${filePath} to stabilize`);
        return false;
      }

      try {
        const { size } = await stat(filePath);
        if (size === lastSize) {
          stableCount++;
        } else {
          stableCount = 0;
          lastSize = size;
        }
      } catch {
        stableCount = 0;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return true;
  }

  private async hashFile(filePath: string): Promise<string> {
    const buffer = await Bun.file(filePath).arrayBuffer();
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(buffer));
    return hasher.digest('hex');
  }

  private async moveFile(
    src: string,
    dest: string,
    onCollision: Config['onCollision'] = 'skip'
  ): Promise<string | null> {
    let finalDest = dest;
    const exists = await Bun.file(dest).exists();

    if (exists) {
      if (onCollision === 'skip') {
        console.warn(`[${this.name}] Skipping ${src}: destination already exists (${dest})`);
        return null;
      }

      if (onCollision === 'version') {
        const ext = path.extname(dest);
        const base = dest.slice(0, dest.length - ext.length);
        let n = 1;
        while (await Bun.file(`${base} (${n})${ext}`).exists()) {
          n++;
        }
        finalDest = `${base} (${n})${ext}`;
      }
    }

    try {
      await rename(src, finalDest);
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        await Bun.write(finalDest, Bun.file(src));
        await unlink(src);
      } else {
        throw err;
      }
    }

    return finalDest;
  }
}

// ---- Torbox (cloud-based download client) --------------------------------
//
// Uploads .torrent / .magnet files to the TorBox cloud service, polls until
// the torrent is cached / downloaded, then streams video files to the
// configured output folder (which should be the Blackhole watch folder so
// the importer can pick them up automatically).
//
// Architecture:
//   grabber -> .torrent/.magnet file -> [torbox api] -> download -> output/
//                                                                    |
//                                                           BlackholeClient
//                                                           imports to library

export interface TorboxClientConfig {
  apiKey?: string;
  /** Defaults to "https://api.torbox.app" */
  baseUrl?: string;
  /** Folder to watch for .torrent/.magnet files (usually the blackhole outputFolder) */
  inputFolder?: string;
  /** Folder where completed downloads land (usually the blackhole watchFolder) */
  outputFolder?: string;
  /** Max concurrent downloads (default 3) */
  concurrency?: number;
}

/**
 * If the person hasn't explicitly set torbox.outputFolder, default it to
 * blackhole.watchFolder - that's what actually makes the "direct to TorBox"
 * flow work end-to-end without extra config: TorBox drops finished files
 * straight where Blackhole is already watching to import them.
 */
export function resolveTorboxConfig(config: Config): Config {
  const dc = config.downloadClient;
  if (!dc?.torbox || dc.torbox.outputFolder) return config;

  return {
    ...config,
    downloadClient: {
      ...dc,
      torbox: {
        ...dc.torbox,
        outputFolder: dc.blackhole?.watchFolder,
      },
    },
  };
}

export class TorboxDownloadClient implements DownloadClient {
  name = 'TorBox';

  private service: TorboxService;
  private config: TorboxClientConfig;
  private processing = new Set<string>();
  private activeTitles = new Set<string>();
  private watchHandle: ReturnType<typeof watch> | null = null;

  constructor(config: Config) {
    const raw = config.downloadClient?.torbox;
    this.config = {
      apiKey: raw?.apiKey || '',
      baseUrl: raw?.baseUrl || 'https://api.torbox.app',
      inputFolder: raw?.inputFolder || './hotio',
      outputFolder: raw?.outputFolder || './downloads',
      concurrency: raw?.concurrency || 3,
    };
    this.service = new TorboxService({
      apiKey: this.config.apiKey!,
      baseUrl: this.config.baseUrl!,
    });
  }

  async start() {
    if (!this.config.apiKey) {
      console.log(`[${this.name}] No API key configured. Skipping.`);
      return;
    }

    await mkdir(this.config.inputFolder!, { recursive: true });
    await mkdir(this.config.outputFolder!, { recursive: true });

    console.log(`[${this.name}] Watching ${this.config.inputFolder} for torrent/magnet files`);
    console.log(`[${this.name}] Output folder: ${this.config.outputFolder}`);

    // Scan existing files
    try {
      const files = await readdir(this.config.inputFolder!);
      for (const file of files) {
        if (file.endsWith('.torrent') || file.endsWith('.magnet') || file.endsWith('.txt')) {
          this.processFile(path.join(this.config.inputFolder!, file));
        }
      }
    } catch { }

    this.watchHandle = watch(this.config.inputFolder!, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return;
      const fullPath = path.join(this.config.inputFolder!, filename);
      if (!existsSync(fullPath)) return;
      if (!filename.endsWith('.torrent') && !filename.endsWith('.magnet') && !filename.endsWith('.txt')) return;
      this.processFile(fullPath);
    });

    console.log(`[${this.name}] Running.`);
  }

  async stop() {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = null;
    }
  }

  /**
   * Directly submit a magnet link to TorBox, poll, and download.
   * Returns true on success.
   */
  async submitMagnet(magnet: string, label?: string): Promise<boolean> {
    const addRes = await this.service.addTorrent({ magnet, name: label });
    if (!addRes.success) {
      console.error(`[${this.name}] Failed to submit magnet:`, addRes.error);
      return false;
    }
    const data = addRes.result?.data || addRes.result;
    const torrentId = String(data?.torrent_id || data?.id || '');
    if (!torrentId || torrentId === 'undefined' || torrentId === '') {
      console.error(`[${this.name}] No torrent ID from magnet submit:`, JSON.stringify(addRes));
      return false;
    }
    return this.waitForDownload(torrentId, label || 'magnet');
  }

  /**
   * Fetch a .torrent from a URL and submit it to TorBox, poll, and download.
   * Returns true on success.
   */
  async submitTorrentUrl(url: string, label?: string): Promise<boolean> {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[${this.name}] Failed to fetch torrent from ${url}: ${res.status}`);
      return false;
    }
    const blob = await res.blob();
    const addRes = await this.service.addTorrent({ file: blob, name: label || 'torrent' });
    if (!addRes.success) {
      console.error(`[${this.name}] Failed to submit torrent:`, addRes.error);
      return false;
    }
    const data = addRes.result?.data || addRes.result;
    const torrentId = String(data?.torrent_id || data?.id || '');
    if (!torrentId || torrentId === 'undefined' || torrentId === '') {
      console.error(`[${this.name}] No torrent ID from torrent submit:`, JSON.stringify(addRes));
      return false;
    }
    return this.waitForDownload(torrentId, label || url);
  }

  /**
   * Submit a release (from indexer search) directly to TorBox.
   * Uses magnetUrl, downloadUrl, or infoHash in that order.
   */
  async submitRelease(release: { magnetUrl?: string; downloadUrl?: string; infoHash?: string; title: string }): Promise<boolean> {
    const { magnetUrl, downloadUrl, infoHash, title } = release;

    if (magnetUrl?.startsWith('magnet:')) {
      return this.submitMagnet(magnetUrl, title);
    }

    if (downloadUrl) {
      return this.submitTorrentUrl(downloadUrl, title);
    }

    if (infoHash) {
      const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
      return this.submitMagnet(magnet, title);
    }

    console.error(`[${this.name}] Release "${title}" has no magnetUrl, downloadUrl, or infoHash`);
    return false;
  }

  /**
   * Titles currently mid-flight - submitted to TorBox and either still
   * being cached/downloaded there, or being pulled down to outputFolder.
   * Surfaced on the Queue page alongside Blackhole's local processing queue
   * so "active downloads" reflects both download paths in one place.
   */
  getActiveDownloads(): string[] {
    return [...this.activeTitles];
  }

  /**
   * Submits a release to TorBox and resolves as soon as it's accepted -
   * NOT once it's fully downloaded. The actual poll-and-fetch continues in
   * the background and reports its own completion/failure via db events,
   * so callers on an HTTP request path (the grab endpoints) return quickly
   * instead of blocking for however long the torrent takes to finish -
   * `waitForDownload` alone can poll for up to 100 minutes.
   */
  async submitReleaseBackground(release: { magnetUrl?: string; downloadUrl?: string; infoHash?: string; title: string }): Promise<{ ok: boolean; message: string }> {
    const { magnetUrl, downloadUrl, infoHash, title } = release;

    let addRes: Awaited<ReturnType<TorboxService['addTorrent']>>;

    if (magnetUrl?.startsWith('magnet:')) {
      addRes = await this.service.addTorrent({ magnet: magnetUrl, name: title });
    } else if (downloadUrl) {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        return { ok: false, message: `Failed to fetch release file for "${title}": HTTP ${res.status}` };
      }
      const blob = await res.blob();
      addRes = await this.service.addTorrent({ file: blob, name: title });
    } else if (infoHash) {
      const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
      addRes = await this.service.addTorrent({ magnet, name: title });
    } else {
      return { ok: false, message: `Release "${title}" has no magnetUrl, downloadUrl, or infoHash` };
    }

    if (!addRes.success) {
      const errMsg = addRes.error instanceof Error ? addRes.error.message : String(addRes.error ?? 'unknown error');
      return { ok: false, message: `TorBox rejected "${title}": ${errMsg}` };
    }

    const data = addRes.result?.data || addRes.result;
    const torrentId = String(data?.torrent_id || data?.id || '');
    if (!torrentId || torrentId === 'undefined') {
      return { ok: false, message: `TorBox returned no torrent ID for "${title}"` };
    }

    this.activeTitles.add(title);

    // Detached - deliberately not awaited. Progress is reported via db
    // events rather than the caller's response.
    this.waitForDownload(torrentId, title)
      .then((ok) => {
        db.logEvent({
          type: ok ? 'download' : 'error',
          entityType: 'release',
          message: ok
            ? `Downloaded "${title}" from TorBox and handed off for import`
            : `TorBox download failed or timed out for "${title}"`,
        });
      })
      .catch((err) => {
        db.logEvent({
          type: 'error',
          entityType: 'release',
          message: `TorBox download error for "${title}": ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => {
        this.activeTitles.delete(title);
      });

    return { ok: true, message: `Submitted "${title}" to TorBox` };
  }

  /** Shared poll-and-download loop. */
  private async waitForDownload(torrentId: string, label: string): Promise<boolean> {
    console.log(`[${this.name}] Torrent ${torrentId} ("${label}"). Waiting for download...`);

    const maxAttempts = 600;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const status = await this.service.getStatus(torrentId);
      if (status.success && status.result) {
        let torrent = status.result.data || status.result;
        if (Array.isArray(torrent)) {
          torrent = torrent.find((t: any) => String(t.id) === torrentId);
        }
        if (!torrent) {
          attempts++;
          await new Promise(r => setTimeout(r, 10_000));
          continue;
        }
        if (torrent.download_finished === true || torrent.download_state === 'completed' || torrent.cached === true) {
          const files = (torrent.files || []).filter((f: any) => {
            const name = (f.name || '').toLowerCase();
            return ['.mkv', '.mp4', '.avi', '.mov'].some(ext => name.endsWith(ext));
          });

          if (files.length === 0) {
            console.warn(`[${this.name}] No video files in torrent ${torrentId}`);
            return false;
          }

          for (const file of files) {
            const dl = await this.service.requestDownload({ torrentId, fileId: file.id });
            if (!dl.success) {
              console.warn(`[${this.name}] Failed to get link for ${file.short_name || file.id}: ${JSON.stringify(dl.error)}`);
              continue;
            }
            const url = dl.result?.data || dl.result?.download_link || (typeof dl.result === 'string' ? dl.result : null);
            if (!url) {
              console.warn(`[${this.name}] No download URL for ${file.short_name || file.id}`);
              continue;
            }

            const outputPath = path.join(this.config.outputFolder!, file.short_name || `file_${file.id}.mkv`);
            const res = await fetch(url);
            if (!res.ok) {
              console.warn(`[${this.name}] Download failed for ${file.short_name || file.id}: ${res.statusText}`);
              continue;
            }
            await Bun.write(outputPath, res);
            console.log(`[${this.name}] Downloaded ${file.short_name || file.id} -> ${outputPath}`);
          }

          return true;
        }
      }

      attempts++;
      await new Promise(r => setTimeout(r, 10_000));
    }

    console.error(`[${this.name}] Torrent ${torrentId} did not complete within time limit`);
    return false;
  }

  private async processFile(filePath: string) {
    if (this.processing.has(filePath)) return;
    this.processing.add(filePath);

    try {
      const fileName = path.basename(filePath);
      const isTorrent = filePath.endsWith('.torrent');
      const isMagnet = filePath.endsWith('.magnet') || filePath.endsWith('.txt');

      if (!isTorrent && !isMagnet) return;

      const isTxtMagnet = isMagnet && !fileName.endsWith('.txt');
      const rawText = isMagnet ? await Bun.file(filePath).text() : '';
      const isContentMagnet = rawText.trim().startsWith('magnet:');

      if (isContentMagnet) {
        const ok = await this.submitMagnet(rawText.trim(), fileName);
        if (ok) try { await unlink(filePath); } catch { }
      } else if (isTorrent) {
        const file = Bun.file(filePath);
        const addRes = await this.service.addTorrent({ file, name: fileName });
        if (!addRes.success) throw addRes.error || new Error('Failed to add torrent');
        const data = addRes.result?.data || addRes.result;
        const torrentId = String(data?.torrent_id || data?.id || '');
        if (!torrentId || torrentId === 'undefined' || torrentId === '') {
          console.error(`[${this.name}] TorBox API response:`, JSON.stringify(addRes));
          throw new Error('No torrent ID returned from TorBox');
        }
        const ok = await this.waitForDownload(torrentId, fileName);
        if (ok) try { await unlink(filePath); } catch { }
      } else {
        console.log(`[${this.name}] Skipping unrecognized file: ${fileName}`);
      }
    } catch (err) {
      console.error(`[${this.name}] Error processing ${path.basename(filePath)}:`, err);
      db.logEvent({
        type: 'error',
        entityType: 'file',
        message: `[${this.name}] Failed to process ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`
      });
    } finally {
      this.processing.delete(filePath);
    }
  }
}
