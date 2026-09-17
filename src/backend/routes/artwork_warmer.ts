import { db } from '../db';
import { ProviderFactory } from '../providers/factory';
import { extractPosterUrl, loadConfig, toCardPosterUrl } from './_shared';

/**
 * Background artwork warm-up (issues #31): page and image serving must
 * NEVER wait on external network. Poster routes serve strictly from the
 * show_artworks bytes in the DB; on a miss they enqueue the show here and
 * return 404 immediately. This module fetches the remote art (provider
 * metadata + image bytes for both full and card variants) with bounded
 * concurrency, so a cold library grid warms itself over ~a minute instead
 * of stalling hundreds of requests behind TVDB rate limits.
 *
 * Dedupe: a show warms at most once at a time, and a failed warm isn't
 * retried for 10 minutes (negative backoff) so a dead provider URL can't
 * spin forever.
 */
const queue: string[] = [];
const inFlight = new Set<string>();
const lastAttempt = new Map<string, number>();
let active = 0;

const MAX_CONCURRENT = 4;
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export function warmPoster(showId: string): void {
  if (!showId || inFlight.has(showId) || queue.includes(showId)) return;
  queue.push(showId);
  void pump();
}

async function pump(): Promise<void> {
  if (active >= MAX_CONCURRENT) return;
  const showId = queue.shift();
  if (!showId) return;
  active++;
  inFlight.add(showId);
  try {
    await warmOne(showId);
  } catch (err) {
    console.warn(`[artwork-warmer] warm failed for show ${showId}:`, err);
  } finally {
    active--;
    inFlight.delete(showId);
    lastAttempt.set(showId, Date.now());
    void pump();
  }
}

async function warmOne(showId: string): Promise<void> {
  if (Date.now() - (lastAttempt.get(showId) ?? 0) < RETRY_COOLDOWN_MS) return;
  const show = db.getShow(showId);
  if (!show) return;

  const cached = db.getShowArtworks(showId, 2) as any[];
  const config = loadConfig();
  const provider = ProviderFactory.getProvider(show.provider_type, config);
  const showData = await provider.getShow(show.provider_id);
  const fullUrl = extractPosterUrl(show.provider_type, showData.metadata);
  if (!fullUrl) return;

  const cardUrl = toCardPosterUrl(show.provider_type, fullUrl) ?? fullUrl;
  for (const url of new Set([fullUrl, cardUrl])) {
    if (cached.some((a) => a.image_url === url && a.data)) continue;
    const res = await fetch(url);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    db.saveShowArtwork(
      showId, 2, url, undefined, undefined, undefined,
      bytes, res.headers.get('Content-Type') ?? 'image/jpeg',
    );
  }
}
