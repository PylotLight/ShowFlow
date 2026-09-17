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
 * Dedupe: a show warms at most once at a time. A failed warm is retried after
 * a short cooldown so a transient provider hiccup (or a 429 burst right after
 * a bulk add) self-heals on the next view instead of blackholing the artwork
 * for minutes. A *successful* warm clears the entry entirely. Callers that
 * know fresh artwork is available (sync just fetched metadata) pass
 * `force` to warm immediately regardless of recent attempts.
 */
const queue: string[] = [];
const inFlight = new Set<string>();
const forceSet = new Set<string>();
const lastAttempt = new Map<string, number>();
let active = 0;

const MAX_CONCURRENT = 4;
const RETRY_COOLDOWN_MS = 60 * 1000;

export function warmPoster(showId: string, opts?: { force?: boolean }): void {
  if (!showId || inFlight.has(showId) || queue.includes(showId)) return;
  if (opts?.force) forceSet.add(showId);
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
    const ok = await warmOne(showId);
    // Only remember a failure. A successful warm clears any prior attempt so a
    // later size variant can still be filled without waiting out a cooldown.
    if (ok) lastAttempt.delete(showId);
  } catch (err) {
    console.warn(`[artwork-warmer] warm failed for show ${showId}:`, err);
  } finally {
    active--;
    inFlight.delete(showId);
    forceSet.delete(showId);
    lastAttempt.set(showId, Date.now());
    void pump();
  }
}

/** @returns true when poster bytes are present for every wanted size variant. */
async function warmOne(showId: string): Promise<boolean> {
  const force = forceSet.has(showId);
  if (!force && Date.now() - (lastAttempt.get(showId) ?? 0) < RETRY_COOLDOWN_MS) return true;
  const show = db.getShow(showId);
  if (!show) return true;

  const cached = db.getShowArtworks(showId, 2) as any[];
  const config = loadConfig();

  // Prefer the poster URL already recorded in synced metadata — a show we've
  // synced never needs another TMDB *API* call to find its art, so warming a
  // bulk add can't storm the rate-limited metadata endpoint (which, on a 429,
  // would leave every card stuck on the placeholder). Only fetch metadata from
  // the provider when we still have nothing to work from.
  let posterPath: string | null = null;
  try {
    const stored = typeof show.provider_metadata === 'string' ? JSON.parse(show.provider_metadata) : show.provider_metadata;
    posterPath = extractPosterUrl(show.provider_type, stored);
  } catch {}
  if (!posterPath) {
    const provider = ProviderFactory.getProvider(show.provider_type, config);
    const showData = await provider.getShow(show.provider_id);
    posterPath = extractPosterUrl(show.provider_type, showData.metadata);
  }
  if (!posterPath) return true;

  // show_artworks keeps ONE row per (show, provider, type) (schema UNIQUE), so
  // store the size the UI actually asks for: the lightweight card variant when
  // the provider offers one (grids + heroes both request ?size=card), else the
  // full poster. The serving route falls back to whatever's stored for the
  // other size.
  const storeUrl = toCardPosterUrl(show.provider_type, posterPath) ?? posterPath;
  if (cached.some(a => a.image_url === storeUrl && a.data)) return true;
  const res = await fetch(storeUrl);
  if (!res.ok) return false;
  const bytes = new Uint8Array(await res.arrayBuffer());
  db.saveShowArtwork(
    showId, 2, storeUrl, undefined, undefined, undefined,
    bytes, res.headers.get('Content-Type') ?? 'image/jpeg',
  );
  return true;
}
