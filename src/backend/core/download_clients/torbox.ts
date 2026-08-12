import { watch } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { db } from '../../db';
import type { Config } from '../../db';
import { TorboxService } from '../../providers/torbox/services';
import { backgroundJobs } from '../background_jobs';
import type { DownloadClient } from './types';

export interface TorboxClientConfig {
  apiKey?: string;
  baseUrl?: string;
  inputFolder?: string;
  outputFolder?: string;
  concurrency?: number;
}

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
  private activeDetails = new Map<string, { state: string; progress: number | null }>();
  private watchHandle: ReturnType<typeof watch> | null = null;

  constructor(config: Config) {
    const raw = config.downloadClient?.torbox;
    this.config = {
      apiKey: raw?.apiKey || '',
      baseUrl: raw?.baseUrl || 'https://api.torbox.app',
      inputFolder: raw?.inputFolder || '',
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

    if (!this.config.inputFolder) {
      console.log(`[${this.name}] No input folder configured. Skipping local torrent watch (TorBox polling only).`);
    } else {
      await mkdir(this.config.inputFolder, { recursive: true });
    }
    await mkdir(this.config.outputFolder!, { recursive: true });

    console.log(`[${this.name}] ${this.config.inputFolder ? `Watching ${this.config.inputFolder} for torrent/magnet files` : 'Torrent hash/magnet submissions enabled'}`);
    console.log(`[${this.name}] Output folder: ${this.config.outputFolder}`);

    if (this.config.inputFolder) {
      try {
        const files = await readdir(this.config.inputFolder);
        for (const file of files) {
          if (file.endsWith('.torrent') || file.endsWith('.magnet') || file.endsWith('.txt')) {
            this.processFile(path.join(this.config.inputFolder!, file));
          }
        }
      } catch { }

      this.watchHandle = watch(this.config.inputFolder, (eventType, filename) => {
        if (eventType !== 'rename' || !filename) return;
        const fullPath = path.join(this.config.inputFolder!, filename);
        if (!existsSync(fullPath)) return;
        if (!filename.endsWith('.torrent') && !filename.endsWith('.magnet') && !filename.endsWith('.txt')) return;
        this.processFile(fullPath);
      });

      // An unhandled 'error' event on the FSWatcher is fatal to the process
      // (same crash class we guard against in BlackholeClient). Surface it as
      // a logged event instead of letting Bun die.
      this.watchHandle.on('error', (err: Error) => {
        const message = err?.message ?? String(err);
        console.error(`[${this.name}] Watch error on "${this.config.inputFolder}": ${message}`);
        try { db.logEvent({ type: 'error', entityType: 'system', message: `TorBox input folder "${this.config.inputFolder}" became unavailable: ${message}` }); } catch {}
      });
    }

    console.log(`[${this.name}] Running.`);
  }

  async stop() {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = null;
    }
  }

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

  getActiveDownloads(): string[] {
    return [...this.activeTitles];
  }

  getActiveDownloadsDetail(): { title: string; state: string; progress: number | null }[] {
    return [...this.activeTitles].map(title => ({
      title,
      ...(this.activeDetails.get(title) ?? { state: 'queued', progress: null }),
    }));
  }

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

  private async waitForDownload(torrentId: string, label: string): Promise<boolean> {
    console.log(`[${this.name}] Torrent ${torrentId} ("${label}"). Waiting for download...`);

    // Expose this download in the header popover + queue as a live job.
    const jobId = `torbox-grab-${torrentId}`;
    this.activeDetails.set(label, { state: 'queued', progress: 0 });
    backgroundJobs.register({
      id: jobId,
      type: 'torbox-grab',
      label: `Downloading: ${label}`,
      total: 100,
      link: '/queue',
    });

    const failJob = (message: string) => {
      backgroundJobs.fail(jobId, message);
    };

    const maxAttempts = 600; // ~100 minutes with the adaptive schedule below
    let attempts = 0;
    let lastLoggedState = '';
    let transientFailures = 0;

    while (attempts < maxAttempts) {
      let status: Awaited<ReturnType<TorboxService['getStatus']>> | null = null;
      try {
        status = await this.service.getStatus(torrentId);
        transientFailures = 0; // reset on successful API call
      } catch (err) {
        transientFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.name}] Status check ${attempts + 1} for ${torrentId} failed (attempt ${transientFailures}): ${msg}`);

        if (transientFailures >= 12) {
          db.logEvent({
            type: 'error',
            entityType: 'release',
            message: `TorBox status polling failed repeatedly for "${label}" (torrent ${torrentId}): ${msg}. Download state unknown.`,
          });
          this.activeDetails.delete(label);
          failJob(`Status polling failed: ${msg}`);
          return false;
        }
      }

      if (status?.success && status.result) {
        let torrent = status.result.data || status.result;
        if (Array.isArray(torrent)) {
          torrent = torrent.find((t: any) => String(t.id) === torrentId || String(t.torrent_id) === torrentId);
        }

        if (!torrent) {
          // Torrent no longer in list — could be removed/expired externally
          console.warn(`[${this.name}] Torrent ${torrentId} no longer appears in TorBox list — assuming removed/expired`);
          db.logEvent({
            type: 'error',
            entityType: 'release',
            message: `TorBox torrent ${torrentId} ("${label}") disappeared from the account — download likely removed or expired.`,
          });
          this.activeDetails.delete(label);
          failJob('Torrent disappeared from TorBox account');
          return false;
        }

        const rawState = String(torrent.download_state || '').toLowerCase();
        const progress = typeof torrent.progress === 'number' ? Math.round(torrent.progress * 100) : null;

        // Log state transitions so operators can see the download progressing
        const stateSummary = `${rawState || 'unknown'}${progress != null ? ` ${progress}%` : ''}`;
        if (stateSummary !== lastLoggedState) {
          console.log(`[${this.name}] ${torrentId} state: ${stateSummary}`);
          lastLoggedState = stateSummary;
        }

        // Publish live progress to the header job + queue page.
        this.activeDetails.set(label, { state: stateSummary, progress });
        backgroundJobs.update(jobId, {
          total: 100,
          completed: progress ?? 0,
          detail: stateSummary,
        });

        // Terminal failure states — bail out early instead of polling forever
        if (rawState.includes('error') || rawState.includes('fail') || rawState.includes('stalled')) {
          console.error(`[${this.name}] Torrent ${torrentId} entered terminal failure state: ${rawState}`);
          db.logEvent({
            type: 'error',
            entityType: 'release',
            message: `TorBox download failed for "${label}" (state: ${rawState}).`,
          });
          this.activeDetails.delete(label);
          failJob(`Torrent entered ${rawState} state`);
          return false;
        }

        const isComplete = torrent.download_finished === true || torrent.download_state === 'completed' || torrent.cached === true;
        if (isComplete) {
          const files = (torrent.files || []).filter((f: any) => {
            const name = (f.name || '').toLowerCase();
            return ['.mkv', '.mp4', '.avi', '.mov'].some(ext => name.endsWith(ext));
          });

          if (files.length === 0) {
            const allNames = (torrent.files || []).map((f: any) => f.name).join(', ');
            console.warn(`[${this.name}] No video files in torrent ${torrentId}. Available: ${allNames}`);
            db.logEvent({
              type: 'error',
              entityType: 'release',
              message: `TorBox download for "${label}" completed but contained no video files (found: ${allNames}).`,
            });
            this.activeDetails.delete(label);
            failJob('Torrent completed but contained no video files');
            return false;
          }

          let anyDownloaded = false;
          for (const file of files) {
            const dl = await this.service.requestDownload({ torrentId, fileId: file.id });
            if (!dl.success) {
              const errText = JSON.stringify(dl.error);
              console.warn(`[${this.name}] Failed to get link for ${file.short_name || file.id}: ${errText}`);
              db.logEvent({
                type: 'error', entityType: 'release',
                message: `TorBox download-link request failed for "${label}" file ${file.short_name || file.id}: ${errText}`,
              });
              continue;
            }
            const url = dl.result?.data || dl.result?.download_link || (typeof dl.result === 'string' ? dl.result : null);
            if (!url) {
              console.warn(`[${this.name}] No download URL for ${file.short_name || file.id}`);
              db.logEvent({
                type: 'error', entityType: 'release',
                message: `TorBox returned no download URL for "${label}" file ${file.short_name || file.id}.`,
              });
              continue;
            }

            const outputPath = path.join(this.config.outputFolder!, file.short_name || `file_${file.id}.mkv`);
            try {
              const res = await fetch(url);
              if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.warn(`[${this.name}] Download failed for ${file.short_name || file.id}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
                db.logEvent({
                  type: 'error', entityType: 'release',
                  message: `TorBox HTTP download failed for "${label}": ${res.status} ${res.statusText}`,
                });
                continue;
              }
              const data = await res.arrayBuffer();
              await Bun.write(outputPath, data);
              console.log(`[${this.name}] Downloaded ${file.short_name || file.id} -> ${outputPath}`);
              anyDownloaded = true;
            } catch (fetchErr) {
              const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              console.warn(`[${this.name}] Fetch/write failed for ${file.short_name || file.id}: ${msg}`);
              db.logEvent({
                type: 'error', entityType: 'release',
                message: `TorBox download write failed for "${label}": ${msg}`,
              });
            }
          }

          if (anyDownloaded) {
            this.activeDetails.delete(label);
            backgroundJobs.complete(jobId, 'Downloaded — handed off for import');
            return true;
          } else {
            db.logEvent({
              type: 'error',
              entityType: 'release',
              message: `TorBox download for "${label}" marked complete but every file download failed.`,
            });
            this.activeDetails.delete(label);
            failJob('Every file download failed');
            return false;
          }
        }
      }

      attempts++;
      // Slightly back off while we're waiting — keeps log noise down and is
      // kinder to TorBox's rate limits during long cache waits.
      const delayMs = attempts < 30 ? 10_000 : attempts < 120 ? 15_000 : 20_000;
      await new Promise(r => setTimeout(r, delayMs));
    }

    console.error(`[${this.name}] Torrent ${torrentId} did not complete within time limit (${maxAttempts} polls)`);
    db.logEvent({
      type: 'error',
      entityType: 'release',
      message: `TorBox download timed out for "${label}" after ${maxAttempts} status checks (~${Math.round(maxAttempts * 15 / 60)} minutes).`,
    });
    this.activeDetails.delete(label);
    failJob('Download timed out');
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
