import { watch, readFileSync } from 'node:fs';
import { rename, mkdir, unlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Oracle } from '../../parser/oracle';
import { db } from '../../db';
import type { ProviderType } from '../../providers/factory';
import { debugLog } from '../debug';
import { maybeForcedGc } from '../memory_guard';
import { qualityEngine } from '../quality_engine';
import type { Config } from '../../db';
import type { DownloadClient } from './types';

export class BlackholeClient implements DownloadClient {
  name = 'Blackhole';
  private oracle = new Oracle();

  private processingQueue: Set<string> = new Set();
  private pendingQueue: string[] = [];
  private pendingSet: Set<string> = new Set();
  private queueWorkerRunning = false;

  private watchHandle: any = null;
  private watchFolder: string | null = null;

  /** Read-only diagnostic helpers that work inside a shell-less (distroless)
   *  container: the app process reads its own cgroup/proc files. */
  private static readCgroupMemory(): string {
    // cgroup v2: /sys/fs/cgroup/memory.current & memory.max
    try {
      const cur = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
      const max = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
      return `${(cur / 1048576).toFixed(0)}/${(max / 1048576).toFixed(0)}MB`;
    } catch {
      try {
        // cgroup v1
        const cur = Number(readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'));
        const max = Number(readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'));
        return `${(cur / 1048576).toFixed(0)}/${(max / 1048576).toFixed(0)}MB`;
      } catch {
        return 'n/a';
      }
    }
  }

  private static readVmRss(): string {
    try {
      const status = readFileSync('/proc/self/status', 'utf8');
      return status.match(/VmRSS:\s+(\d+\s+\w+)/)?.[1] ?? 'n/a';
    } catch {
      return 'n/a';
    }
  }

  private static mem(label: string): void {
    const u = process.memoryUsage();
    const tag = `[${process.pid}] mem(${label}) rss=${(u.rss / 1048576).toFixed(0)}MB heap=${(u.heapUsed / 1048576).toFixed(0)}MB ext=${(u.external / 1048576).toFixed(0)}MB ab=${(u.arrayBuffers / 1048576).toFixed(0)}MB cgroup=${this.readCgroupMemory()} vmrss=${this.readVmRss()}`;
    console.log(tag);
  }

  private static readonly SAFETY_RESCAN_INTERVAL_MS = 3 * 60 * 1000;
  private safetyRescanHandle: ReturnType<typeof setInterval> | null = null;

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

    await this.scanExistingFiles(folder);

    try {
      this.watchHandle = watch(folder, (eventType, filename) => {
        if (eventType === 'rename' && filename) {
          this.enqueue(folder, filename);
        }
      });
      // An unhandled 'error' event on the FSWatcher is fatal to the process
      // (e.g. when the watch folder is unmounted or loses write access
      // mid-run, macOS fires an async 'error'). Surface it as a logged event
      // instead of letting Bun die.
      this.watchHandle.on('error', (err: Error) => {
        const message = err?.message ?? String(err);
        console.error(`[${this.name}] Watch error on "${folder}": ${message}`);
        db.logEvent({
          type: 'error',
          entityType: 'system',
          message: `Watch folder "${folder}" became unavailable: ${message}`,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] Failed to watch watch folder "${folder}": ${message}`);
      db.logEvent({
        type: 'error',
        entityType: 'system',
        message: `Watch folder "${folder}" is missing or not writable: ${message}`,
      });
    }

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
          continue;
        }

        this.enqueue(folder, filename);
        queuedCount++;
      }

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

  private enqueue(folder: string, filename: string) {
    const fullPath = path.join(folder, filename);

    if (this.pendingSet.has(fullPath) || this.processingQueue.has(fullPath)) {
      return;
    }

    this.pendingSet.add(fullPath);
    this.pendingQueue.push(filename);

    void this.runQueue(folder);
  }

  private async runQueue(folder: string) {
    if (this.queueWorkerRunning) return;
    this.queueWorkerRunning = true;

    try {
      while (this.pendingQueue.length > 0) {
        const filename = this.pendingQueue.shift()!;
        const fullPath = path.join(folder, filename);
        this.pendingSet.delete(fullPath);

        BlackholeClient.mem('before handle: ' + filename.slice(0, 40));
        await this.handleFile(folder, filename);
        BlackholeClient.mem('after handle: ' + filename.slice(0, 40));
        maybeForcedGc();
      }
    } finally {
      this.queueWorkerRunning = false;
    }
  }

  getWatchFolder(): string | null {
    return this.watchFolder;
  }

  getProcessingFiles(): string[] {
    const active = Array.from(this.processingQueue).map(p => path.basename(p));
    return [...active, ...this.pendingQueue];
  }

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
      }
      return;
    }

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
      BlackholeClient.mem('after hash ' + filename.slice(0, 30));
      maybeForcedGc();
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
      BlackholeClient.mem('after oracle ' + filename.slice(0, 30));
      maybeForcedGc();

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

      debugLog('Show resolved successfully', {
        filename,
        showTitle: show.title,
        provider: show.provider,
        showId: show.id
      });

      let existingShow = db.getShowByProvider(show.provider, show.id);
      let showId: string;

      if (existingShow) {
        showId = existingShow.id;
      } else {
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

      for (const ep of episodes) {
        db.logPipelineEvent({
          showId, seasonNumber: ep.season, episodeNumber: ep.episode,
          stage: 'IMPORTING', eventType: 'import_started',
          message: `Processing "${filename}" for ${show.title}`,
          releaseTitle: filename,
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
        for (const ep of episodes) {
          db.logPipelineEvent({
            showId, seasonNumber: ep.season, episodeNumber: ep.episode,
            stage: 'FAILED', eventType: 'import_failed',
            message: `No root folder configured for ${show.title}`,
            releaseTitle: filename,
          });
        }
        return;
      }
      const finalPath = path.join(rootFolder, proposedPath);

      if (this.config.dryRun) {
        console.log(`[${this.name}] [dry-run] Would move ${filename} -> ${finalPath}`);
        db.logEvent({ type: 'dryrun', entityType: 'file', message: `[dry-run] Would import ${filename} for ${show.title}` });
        return;
      }

      const firstEp = episodes[0];
      if (firstEp) {
        const existingEp = db.getEpisode(showId, firstEp.season, firstEp.episode);
        if (existingEp && existingEp.file_path) {
          const existingFilename = path.basename(existingEp.file_path);
          const profileId = db.getShow(showId)?.profile || 'standard';

          if (opts?.force) {
            console.log(`[${this.name}] Force-importing ${filename} (skipping upgrade check over ${existingFilename}).`);
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
            if (firstEp) {
              db.logPipelineEvent({
                showId, seasonNumber: firstEp.season, episodeNumber: firstEp.episode,
                stage: 'GRABBED', eventType: 'import_skipped', reasonCode: 'NOT_AN_UPGRADE',
                message: `"${filename}" is not an upgrade over existing "${existingFilename}"`,
                releaseTitle: filename,
              });
            }
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
      BlackholeClient.mem('after move ' + filename.slice(0, 30));
      maybeForcedGc();

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

      for (const ep of episodes) {
        db.logPipelineEvent({
          showId, seasonNumber: ep.season, episodeNumber: ep.episode,
          stage: 'AVAILABLE', eventType: 'import_completed',
          message: `Imported "${filename}" for ${show.title}`,
          releaseTitle: filename,
          metadata: { filePath: movedTo },
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
    BlackholeClient.mem('hash start');
    const hasher = new Bun.CryptoHasher('sha256');
    // Read in fixed-size slices rather than relying on Bun.file().stream()
    // chunking — the runtime (esp. linux binaries) may yield the whole file
    // as one buffer. A fixed slice bounds memory to HASH_CHUNK regardless.
    const file = Bun.file(filePath);
    const HASH_CHUNK = 4 * 1024 * 1024; // 4MiB
    for (let off = 0; off < file.size; off += HASH_CHUNK) {
      const end = Math.min(off + HASH_CHUNK, file.size);
      const buf = await file.slice(off, end).arrayBuffer();
      hasher.update(new Uint8Array(buf));
    }
    BlackholeClient.mem('hash end');
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
        // Cross-device copy — done in bounded slices so peak memory never
        // scales with file size, regardless of how the runtime streams
        // Bun.file()/Bun.write (macOS may stream but the Linux build may not).
        const srcFile = Bun.file(src);
        const copyChunk = 16 * 1024 * 1024; // 16MiB
        const { createWriteStream } = await import('node:fs');
        const ws = createWriteStream(finalDest, { flags: 'w' });
        try {
          for (let off = 0; off < srcFile.size; off += copyChunk) {
            const end = Math.min(off + copyChunk, srcFile.size);
            const buf = await srcFile.slice(off, end).arrayBuffer();
            const chunk = new Uint8Array(buf);
            if (!ws.write(chunk)) {
              await new Promise<void>((res, rej) => {
                ws.once('drain', res);
                ws.once('error', rej);
              });
            }
          }
          await new Promise<void>((res, rej) => {
            ws.end();
            ws.once('finish', res);
            ws.once('error', rej);
          });
        } catch (e) {
          ws.destroy();
          throw e;
        }
        await unlink(src);
      } else {
        throw err;
      }
    }

    return finalDest;
  }
}
