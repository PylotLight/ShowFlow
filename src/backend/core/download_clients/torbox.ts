import { watch } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
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

/** Downloads that were mid-flight when the process exited, so boot can
 *  re-attach waiters instead of silently dropping grabs on restarts. */
export interface InflightDownload {
  torrentId: string;
  title: string;
}

export const TORBOX_INFLIGHT_KEY = 'torbox.inflight';

export function parseInflight(raw: unknown): InflightDownload[] {
  try {
    const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(val)) return [];
    return val.filter(
      (v: any): v is InflightDownload =>
        !!v && typeof v.torrentId === 'string' && typeof v.title === 'string',
    );
  } catch {
    return [];
  }
}

export function formatBytesShort(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** HTTP statuses worth retrying: rate limits + transient CDN/edge failures.
 *  TorBox sits behind Cloudflare, so 524s on multi-GB links are common. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
export const MAX_FILE_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000];
const HEADER_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_MS = 120_000;

/** Human progress line for the file-fetch phase, e.g.
 *  "Fetching file 2/3 — 35% (1.2 GiB of 3.4 GiB, 8.5 MiB/s)". */
export function formatFetchDetail(
  fileIdx: number,
  fileTotal: number,
  downloaded: number,
  total: number,
  speedBps: number,
): string {
  const pct = total > 0 ? ` — ${Math.min(100, Math.round((downloaded / total) * 100))}%` : '';
  const amounts = total > 0
    ? `${formatBytesShort(downloaded)} of ${formatBytesShort(total)}`
    : formatBytesShort(downloaded);
  const speed = speedBps > 0 ? `, ${formatBytesShort(speedBps)}/s` : '';
  return `Fetching file ${fileIdx}/${fileTotal}${pct} (${amounts}${speed})`;
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

    // Re-attach to downloads that were in flight when the process last
    // exited (rollouts restart the pod mid-download). The TorBox-side
    // torrent is untouched by our restart, so waiting resumes where the
    // polling left off instead of the grab silently disappearing.
    for (const entry of this.readInflight()) {
      if (this.activeTitles.has(entry.title)) continue;
      console.log(`[${this.name}] Resuming in-flight download "${entry.title}" (torrent ${entry.torrentId})`);
      this.trackDownload(entry.torrentId, entry.title);
    }
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

    this.trackDownload(torrentId, title);

    return { ok: true, message: `Submitted "${title}" to TorBox` };
  }

  /**
   * Fire-and-forget waiter with outcome logging: the single funnel for
   * fresh submissions and post-restart resumes, so a grab always ends in
   * a visible event + finished job instead of vanishing.
   */
  trackDownload(torrentId: string, title: string): void {
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
  }

  private readInflight(): InflightDownload[] {
    try {
      return parseInflight(db.getSetting(TORBOX_INFLIGHT_KEY));
    } catch {
      return [];
    }
  }

  private markInflight(entry: InflightDownload): void {
    try {
      const list = this.readInflight().filter(e => e.torrentId !== entry.torrentId);
      list.push(entry);
      db.setSetting(TORBOX_INFLIGHT_KEY, list);
    } catch {}
  }

  private clearInflight(torrentId: string): void {
    try {
      db.setSetting(
        TORBOX_INFLIGHT_KEY,
        this.readInflight().filter(e => e.torrentId !== torrentId),
      );
    } catch {}
  }

  private async waitForDownload(torrentId: string, label: string): Promise<boolean> {
    this.markInflight({ torrentId, title: label });
    try {
      return await this.waitForDownloadInner(torrentId, label);
    } finally {
      this.clearInflight(torrentId);
    }
  }

  /**
   * Stream a fetch response to disk, reporting downloaded bytes, total
   * (when the server sends Content-Length), and rolling speed. Throttled
   * to ~1 update per 1.5s so the job registry isn't spammed per chunk.
   */
  private async fetchToFile(
    res: Response,
    outputPath: string,
    startOffset: number,
    onProgress: (downloaded: number, total: number, speedBps: number) => void,
  ): Promise<void> {
    if (!res.body) throw new Error('Empty response body');
    const remaining = Number(res.headers.get('content-length')) || 0;
    const total = startOffset + remaining;
    const reader = res.body.getReader();
    let downloaded = startOffset;
    let lastEmit = 0;
    let windowBytes = 0;
    let windowStart = Date.now();
    // Stall watchdog: a hung CDN connection must surface as an error (and
    // trigger resume) instead of freezing the job with a dead progress bar.
    let lastByteAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > STALL_TIMEOUT_MS) {
        reader.cancel(new Error(`No bytes received for ${STALL_TIMEOUT_MS / 1000}s (stalled connection)`)).catch(() => {});
      }
    }, 15_000);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outputPath, { flags: startOffset > 0 ? 'a' : 'w' });
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            downloaded += value.byteLength;
            windowBytes += value.byteLength;
            lastByteAt = Date.now();
            if (!stream.write(value)) {
              await new Promise<void>((r) => stream.once('drain', () => r()));
            }
            const now = Date.now();
            if (now - lastEmit > 1500) {
              const dt = (now - windowStart) / 1000;
              onProgress(downloaded, total, dt > 0 ? windowBytes / dt : 0);
              lastEmit = now;
              windowBytes = 0;
              windowStart = now;
            }
          }
          stream.end();
        } catch (e) {
          stream.destroy(e as Error);
          reject(e);
        }
      })();
    }).finally(() => clearInterval(watchdog));
    onProgress(downloaded, total, 0);
  }

  /**
   * Download one torrent file with retries. Each attempt requests a FRESH
   * download link (links expire; a 524 can come from a dead CDN slot),
   * resumes a partial `.part` file via Range when the server honors it, and
   * backs off on transient failures. Only renames into place on success, so
   * the watch folder never sees a truncated video. Returns true on success.
   */
  private async downloadFileWithRetry(args: {
    torrentId: string;
    file: any;
    fileIdx: number;
    filesTotal: number;
    label: string;
    jobId: string;
  }): Promise<{ ok: boolean; lastError: string }> {
    const { torrentId, file, fileIdx, filesTotal, label, jobId } = args;
    const fileName = file.short_name || `file_${file.id}.mkv`;
    const outputPath = path.join(this.config.outputFolder!, fileName);
    // Stage the partial download in a hidden subdir, NOT next to the final
    // file: outputFolder IS the Blackhole watch folder, and watchers must
    // never see a half-written file (a stalled download looks "stable").
    // Same filesystem, so the final rename stays atomic.
    const stagingDir = path.join(this.config.outputFolder!, '.downloading');
    await mkdir(stagingDir, { recursive: true });
    const partPath = path.join(stagingDir, `${fileName}.part`);
    // v0.1.49 staged `<name>.part` next to the final file (visible to the
    // watch-folder mover). Adopt any orphan into staging so those bytes
    // resume instead of re-downloading from zero.
    try {
      const legacy = await stat(`${outputPath}.part`).catch(() => null);
      const staged = await stat(partPath).catch(() => null);
      if (legacy && !staged) await rename(`${outputPath}.part`, partPath);
    } catch {
      // Orphaned partial stays where it is — harmless, mover ignores it now.
    }
    let lastError = 'unknown error';

    const publish = (detail: string, completed: number) => {
      this.activeDetails.set(label, { state: detail, progress: completed });
      backgroundJobs.update(jobId, { total: 100, completed, detail });
    };

    for (let attempt = 1; attempt <= MAX_FILE_ATTEMPTS; attempt++) {
      const tag = `(attempt ${attempt}/${MAX_FILE_ATTEMPTS})`;
      publish(`Requesting download link for file ${fileIdx}/${filesTotal} ${tag}`, 0);

      // Fresh link every attempt.
      let url: string | null = null;
      try {
        const dl = await this.service.requestDownload({ torrentId, fileId: file.id });
        if (!dl.success) {
          lastError = `link request: ${JSON.stringify(dl.error)}`;
        } else {
          url = dl.result?.data || dl.result?.download_link || (typeof dl.result === 'string' ? dl.result : null);
          if (!url) lastError = 'link request returned no URL';
        }
      } catch (e) {
        lastError = `link request threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!url) {
        console.warn(`[${this.name}] ${tag} No download URL for ${fileName}: ${lastError}`);
        if (attempt < MAX_FILE_ATTEMPTS) {
          publish(`Link request failed ${tag} — retrying in ${RETRY_BACKOFF_MS[attempt - 1]! / 1000}s`, 0);
          await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]!));
        }
        continue;
      }

      // Resume offset from any previous partial download.
      let startOffset = 0;
      try {
        startOffset = (await stat(partPath)).size;
      } catch { /* no partial file */ }

      try {
        const headers: Record<string, string> = startOffset > 0 ? { Range: `bytes=${startOffset}-` } : {};
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(HEADER_TIMEOUT_MS) });

        if (startOffset > 0 && res.status !== 206) {
          // Server ignored Range — restart from zero rather than corrupt.
          console.warn(`[${this.name}] ${tag} Range ignored (HTTP ${res.status}) for ${fileName}; restarting`);
          await unlink(partPath).catch(() => {});
          startOffset = 0;
          const res2 = await fetch(url, { signal: AbortSignal.timeout(HEADER_TIMEOUT_MS) });
          if (!res2.ok) {
            lastError = `HTTP ${res2.status} ${res2.statusText}`;
            if (!RETRYABLE_STATUS.has(res2.status)) break;
            console.warn(`[${this.name}] ${tag} Download failed for ${fileName}: ${lastError}`);
            if (attempt < MAX_FILE_ATTEMPTS) {
              publish(`${lastError} ${tag} — retrying in ${RETRY_BACKOFF_MS[attempt - 1]! / 1000}s`, 0);
              await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]!));
            }
            continue;
          }
          await this.fetchToFile(res2, partPath, 0, (downloaded, total, speedBps) => {
            const detail = formatFetchDetail(fileIdx, filesTotal, downloaded, total, speedBps);
            const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
            publish(detail, pct);
          });
          await rename(partPath, outputPath);
          console.log(`[${this.name}] Downloaded ${fileName} -> ${outputPath}`);
          return { ok: true, lastError: '' };
        }

        if (!res.ok) {
          lastError = `HTTP ${res.status} ${res.statusText}`;
          if (!RETRYABLE_STATUS.has(res.status)) {
            console.warn(`[${this.name}] ${tag} Permanent failure for ${fileName}: ${lastError}`);
            db.logEvent({
              type: 'error', entityType: 'release',
              message: `TorBox HTTP download failed for "${label}" (${fileName}): ${lastError} — not retrying.`,
            });
            break;
          }
          console.warn(`[${this.name}] ${tag} Download failed for ${fileName}: ${lastError}`);
          if (attempt < MAX_FILE_ATTEMPTS) {
            publish(`${lastError} ${tag} — retrying in ${RETRY_BACKOFF_MS[attempt - 1]! / 1000}s`, 0);
            await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]!));
          }
          continue;
        }

        await this.fetchToFile(res, partPath, startOffset, (downloaded, total, speedBps) => {
          const detail = formatFetchDetail(fileIdx, filesTotal, downloaded, total, speedBps);
          const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          publish(detail, pct);
        });
        await rename(partPath, outputPath);
        console.log(`[${this.name}] Downloaded ${fileName} -> ${outputPath}`);
        return { ok: true, lastError: '' };
      } catch (fetchErr) {
        lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        console.warn(`[${this.name}] ${tag} Fetch/write failed for ${fileName}: ${lastError}`);
        if (attempt < MAX_FILE_ATTEMPTS) {
          publish(`Connection failed ${tag} — resuming in ${RETRY_BACKOFF_MS[attempt - 1]! / 1000}s`, 0);
          await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]!));
        }
      }
    }

    db.logEvent({
      type: 'error', entityType: 'release',
      message: `TorBox download failed for "${label}" file ${fileName} after ${MAX_FILE_ATTEMPTS} attempts: ${lastError}`,
    });
    return { ok: false, lastError };
  }

  private async waitForDownloadInner(torrentId: string, label: string): Promise<boolean> {
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

        // Publish live state to the header job + queue page. Torrent-side
        // progress is NOT job completion (the file fetch hasn't started),
        // so report indeterminate here — real % flows once bytes move.
        // Previously "cached 100%" rendered a full bar before any download.
        this.activeDetails.set(label, { state: stateSummary, progress: null });
        backgroundJobs.update(jobId, {
          total: 0,
          completed: 0,
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
          let firstError = '';
          for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
            const file = files[fileIdx]!;
            const res = await this.downloadFileWithRetry({
              torrentId, file, fileIdx: fileIdx + 1, filesTotal: files.length, label, jobId,
            });
            if (res.ok) {
              anyDownloaded = true;
            } else if (!firstError) {
              firstError = res.lastError;
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
              message: `TorBox download for "${label}" marked complete but every file download failed.${firstError ? ` Last error: ${firstError}` : ''}`,
            });
            this.activeDetails.delete(label);
            failJob(`Every file download failed${firstError ? ` (${firstError})` : ''}`);
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
