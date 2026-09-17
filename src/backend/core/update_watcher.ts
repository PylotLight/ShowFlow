// Background release watcher — the "sub, don't poll the API" half of the
// update flow.
//
// Why the Atom feed and not api.github.com:
//   `https://github.com/<repo>/releases.atom` is served from GitHub's web CDN,
//   is NOT rate-limited like the REST API, and supports `ETag`/`If-None-Match`
//   revalidation — a poll where nothing changed is a `304 Not Modified`
//   (~200 bytes, zero quota). That lets us check aggressively (every 15 min in
//   the background, ~20s while a user is literally watching the panel) without
//   ever risking a 429. The feed is newest-first and carries the tag + title
//   + release notes; it does NOT carry the asset download URL or the commit
//   SHA (our releaseId), so when a genuinely newer tag appears we make exactly
//   ONE rate-limited API call (downloadAndInstallByTag) to resolve + fetch it.
//   Net effect: quota is spent only per *actual* new release, never per poll.

import { db } from "../db";
import { backgroundJobs } from "./background_jobs";
import { downloadAndInstallByTag } from "./updates_manager";

const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "development";

const FEED_TTL_MS = 15_000;
const PENDING_KEY = "updates:pending";
const AUTO_KEY = "updates:autoDownload";

interface FeedEntry {
  tag: string;
  title: string;
  updated: string | null;
  notes: string | null;
}

export interface PendingUpdate {
  tag: string;
  releaseId: string;
  title: string | null;
  notes: string | null;
  publishedAt: string | null;
  stagedAt: string;
}

export interface WatchResult {
  status: "up-to-date" | "unchanged" | "staged" | "downloaded-not-verified" | "skipped" | "not-configured";
  currentVersion: string;
  latestTag: string | null;
  pending: PendingUpdate | null;
  error?: string;
}

// In-memory feed cache: the ETag + the parsed entries, refreshed only when the
// CDN reports a change. Also a min-interval floor so N foreground panels + the
// scheduler can't stampede the feed.
let etag: string | null = null;
let entries: FeedEntry[] = [];
let lastFetchAt = 0;
let inFlight: Promise<WatchResult> | null = null;

function atomUrl(): string | null {
  const repo = process.env.GITHUB_REPO;
  return repo ? `https://github.com/${repo}/releases.atom` : null;
}

export function isAutoDownloadEnabled(): boolean {
  const raw = db.getSetting(AUTO_KEY);
  if (raw === null || raw === undefined) return true; // default on
  return String(raw) !== "false";
}

export function setAutoDownload(enabled: boolean): void {
  db.setSetting(AUTO_KEY, enabled ? "true" : "false");
}

export function getPendingUpdate(): PendingUpdate | null {
  const raw = db.getSetting(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed.releaseId === "string" && typeof parsed.tag === "string") {
      return parsed as PendingUpdate;
    }
  } catch {
    /* corrupt — treat as none */
  }
  return null;
}

export function clearPendingUpdate(): void {
  db.removeSetting(PENDING_KEY);
}

// ---- Version comparison -------------------------------------------------

/** Strips a leading `v` and compares dotted numeric versions. Returns
 *  >0 if a>b, <0 if a<b, 0 if equal. Non-numeric segments compare lexically
 *  so pre-release suffixes (`-rc1`, `-beta`) never throw us for a loop. */
export function compareVersions(a: string, b: string): number {
  const clean = (s: string) => s.trim().replace(/^v/i, "");
  const pa = clean(a).split(/[.\-+]/);
  const pb = clean(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---- Atom feed parsing --------------------------------------------------
// The feed is fixed, well-formed XML emitted by GitHub. We deliberately avoid
// a full XML parser (none in Bun's stdlib, and adding a dep for this is not
// worth it) and pull just the fields we need from each `<entry>` block.

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h1|h2|h3|div|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseAtomFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const block = m[1]!;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1];
    // Tag comes from the releases/tag/<tag> link — the only place that
    // carries the exact ref independent of the display title.
    const href = /<link[^>]*href="[^"]*\/releases\/tag\/([^"]+)"[^>]*\/?>/.exec(block)?.[1];
    const updated = /<updated>([\s\S]*?)<\/updated>/.exec(block)?.[1];
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(block)?.[1];
    const tag = href ? decodeURIComponent(href) : title ? decodeEntities(title).trim() : null;
    if (!tag) continue;
    out.push({
      tag,
      title: title ? decodeEntities(title).trim() : tag,
      updated: updated?.trim() ?? null,
      notes: content ? stripTags(content) : null,
    });
  }
  return out;
}

async function refreshFeed(force: boolean): Promise<boolean> {
  const url = atomUrl();
  if (!url) return false;
  if (!force && Date.now() - lastFetchAt < FEED_TTL_MS && entries.length > 0) {
    return false; // served from in-memory cache — no outbound request at all
  }
  const headers: Record<string, string> = {
    Accept: "application/atom+xml",
    "User-Agent": "showflow-updates-watcher",
  };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers, cache: "no-cache" });
  if (res.status === 304) {
    lastFetchAt = Date.now();
    return false; // feed unchanged
  }
  if (!res.ok) throw new Error(`releases.atom returned ${res.status}`);
  const newEtag = res.headers.get("etag");
  if (newEtag) etag = newEtag;
  entries = parseAtomFeed(await res.text());
  lastFetchAt = Date.now();
  return true;
}

// ---- Watch cycle --------------------------------------------------------

/**
 * Runs one watcher pass: refresh the feed, and if a strictly-newer release
 * exists that isn't already staged, auto-download + verify it via the
 * supervisor and record it as `pending`. Idempotent and cheap to call —
 * concurrent calls share one in-flight cycle, and a fresh feed hit is throttled
 * to FEED_TTL_MS. Returns the resulting state.
 */
export async function runWatchCycle(opts: { force?: boolean } = {}): Promise<WatchResult> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<WatchResult> => {
    const base: Pick<WatchResult, "currentVersion"> = { currentVersion: BUILD_VERSION };
    const url = atomUrl();
    if (!url) return { ...base, status: "not-configured", latestTag: null, pending: getPendingUpdate() };

    try {
      await refreshFeed(opts.force ?? false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[updates] watcher feed check failed: ${message}`);
      return { ...base, status: "unchanged", latestTag: entries[0]?.tag ?? null, pending: getPendingUpdate(), error: message };
    }

    const latest = entries[0];
    if (!latest) return { ...base, status: "up-to-date", latestTag: null, pending: getPendingUpdate() };

    // Feed is newest-first; still guard with an explicit compare so a
    // mis-sourced entry never "downgrades" us.
    if (compareVersions(latest.tag, BUILD_VERSION) <= 0) {
      return { ...base, status: "up-to-date", latestTag: latest.tag, pending: getPendingUpdate() };
    }

    const pending = getPendingUpdate();

    // Already staged this exact release — nothing to do (drives the
    // "still waiting for you to click Activate" steady state).
    if (pending && pending.tag === latest.tag) {
      return { ...base, status: "staged", latestTag: latest.tag, pending };
    }

    // A pending update exists for a DIFFERENT tag. Only replace it if the new
    // tag is actually newer, so a fast double-publish never downgrades a
    // staged release. If the user disabled auto-download, leave what's staged.
    const replacePending = !pending || compareVersions(latest.tag, pending.tag) > 0;
    if (!isAutoDownloadEnabled() || !replacePending) {
      return { ...base, status: "skipped", latestTag: latest.tag, pending };
    }

    // Genuinely newer release + auto-download on: spend our one API call.
    const jobId = `update-download:${latest.tag}`;
    backgroundJobs.register({ id: jobId, type: 'update-download', label: `Downloading ShowFlow ${latest.title || latest.tag}`, link: '/settings?tab=general' });
    db.logEvent({ type: "update", entityType: "system", entityId: latest.tag, message: `New release ${latest.tag} detected — auto-downloading` });
    console.log(`[updates] new release ${latest.tag} (current ${BUILD_VERSION}) — auto-downloading`);

    const result = await downloadAndInstallByTag(latest.tag);
    if (!result.ok || !result.releaseId) {
      backgroundJobs.fail(jobId, result.message);
      db.logEvent({ type: "error", entityType: "system", entityId: latest.tag, message: `Auto-download of ${latest.tag} failed: ${result.message}` });
      return { ...base, status: "downloaded-not-verified", latestTag: latest.tag, pending, error: result.message };
    }

    backgroundJobs.complete(jobId, `Release ${latest.tag} staged — ready to activate`);

    const record: PendingUpdate = {
      tag: latest.tag,
      releaseId: result.releaseId,
      title: latest.title,
      notes: latest.notes,
      publishedAt: latest.updated,
      stagedAt: new Date().toISOString(),
    };
    db.setSetting(PENDING_KEY, record);
    db.logEvent({ type: "update", entityType: "system", entityId: latest.tag, message: `Release ${latest.tag} downloaded & verified — ready to activate` });
    console.log(`[updates] release ${latest.tag} staged (releaseId ${result.releaseId}) — awaiting activation`);

    return { ...base, status: "staged", latestTag: latest.tag, pending: record };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Called on boot: if the running binary now matches the staged release (we
 * successfully activated), forget the pending record so the notification and
 * the "ready to activate" card disappear.
 */
export function reconcilePendingOnBoot(): void {
  const pending = getPendingUpdate();
  if (pending && compareVersions(pending.tag, BUILD_VERSION) <= 0) {
    clearPendingUpdate();
    console.log(`[updates] cleared pending marker — running release ${pending.tag} matches active version`);
  }
}
