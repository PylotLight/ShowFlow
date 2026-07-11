import { watch } from 'node:fs';
import { rename, mkdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Oracle } from '../parser/oracle';
import { db, type Config } from '../db';
import type { ProviderType } from '../providers/factory';
import { debugLog } from './debug';
import { qualityEngine } from './quality_engine';

export interface DownloadClient {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class BlackholeClient implements DownloadClient {
  name = 'Blackhole';
  private oracle = new Oracle();
  private processingQueue: Set<string> = new Set();
  private watchHandle: any = null;

  constructor(private config: Config) {}

  async start() {
    const folder = this.config.downloadClient?.blackhole?.watchFolder;

    if (!folder) {
      console.log(`[${this.name}] No watch folder configured. Skipping.`);
      return;
    }

    console.log(`[${this.name}] Watching folder: ${folder}`);
    if (this.config.dryRun) {
      console.log(`[${this.name}] Dry-run mode: files will be resolved but NOT moved.`);
    }

    this.watchHandle = watch(folder, async (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        await this.handleFile(folder, filename);
      }
    });
  }

  async stop() {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = null;
    }
  }

  getProcessingFiles(): string[] {
    return Array.from(this.processingQueue).map(p => path.basename(p));
  }

  private async handleFile(folder: string, filename: string) {
    const fullPath = path.join(folder, filename);

    if (this.processingQueue.has(fullPath)) return;
    this.processingQueue.add(fullPath);

    try {
      const stable = await this.waitForStableFile(fullPath);
      if (!stable) return;

      console.log(`[${this.name}] Processing file: ${filename}`);
      debugLog('Processing file', { filename, fullPath });
      
      const hash = await this.hashFile(fullPath);
      if (db.isProcessed(hash)) {
        console.log(`[${this.name}] Skipping duplicate: ${filename}`);
        db.logEvent({ type: 'skip', entityType: 'file', message: `Skipped duplicate: ${filename}` });
        return;
      }

      const result = await this.oracle.resolve(filename, this.config.defaultProvider as ProviderType);

      debugLog('Oracle resolve result', { filename, result });
      if (!result) {
        console.error(`[${this.name}] Could not resolve metadata for ${filename}`);
        db.logEvent({ type: 'error', entityType: 'file', message: `Could not resolve metadata for ${filename}` });
        return;
      }

      const { show, episodes, proposedPath } = result;

      // Resolve UUID: check if show already exists via its provider link
      let existingShow = db.getShowByProvider(show.provider, show.id);
      let showId: string;

      if (existingShow) {
        showId = existingShow.id;
      } else {
        showId = crypto.randomUUID();
        db.saveShow({
          uuid: showId,
          providerId: show.id,
          type: show.provider,
          title: show.title,
          config: {},
        });
      }

      const rootFolder = db.getShowRootFolder(showId) || this.config.libraryPath;
      if (!rootFolder) {
        console.error(`[${this.name}] No root folder configured for ${show.title} and no libraryPath fallback. Skipping.`);
        return;
      }
      const finalPath = path.join(rootFolder, proposedPath);

      if (this.config.dryRun) {
        console.log(`[${this.name}] [dry-run] Would move ${filename} -> ${finalPath}`);
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
          
          if (!qualityEngine.shouldUpgrade(existingFilename, filename, profileId)) {
            console.log(`[${this.name}] New file ${filename} is not an upgrade over ${existingFilename}. Skipping. File remains in watch folder for manual review.`);
            return;
          }
          console.log(`[${this.name}] New file ${filename} is an upgrade over ${existingFilename}. Replacing.`);
          
          // If we are replacing, we should probably move the old file to a backup or just delete it.
          // For now, we'll rely on onCollision 'overwrite' or similar, but explicitly deleting 
          // ensures we don't end up with multiple versions unless requested.
          try {
            await unlink(existingEp.file_path);
          } catch (e) {
            console.warn(`[${this.name}] Failed to remove old file ${existingEp.file_path}:`, e);
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
        db.saveSeason(showId, firstEpisode.season, `Season ${firstEpisode.season}`);
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
      console.error(`[${this.name}] Error processing ${filename}:`, e);
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
