import { db, ConfigSchema, ProwlarrConfigSchema, SonarrConfigSchema, JellyfinConfigSchema } from "../db";
import type { Config } from "../db";
import { IndexerFactory } from "../providers/indexers/factory";
import type { NativeIndexerConfig } from "../providers/indexers/native/types";
import { SonarrClient } from "../providers/sonarr/client";
import { JellyfinClient } from "../providers/jellyfin/client";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { ProviderType } from "../providers/factory";

export type { Config, ProviderType };

// ---- Admin auth -----------------------------------------------------------
export const ADMIN_TOKEN = initAdminToken();

function initAdminToken(): string {
  const existing = db.getSetting("admin_token");
  if (existing) return existing;
  const token = randomUUID();
  db.setSetting("admin_token", token);
  return token;
}

export function checkAdminAuth(req: Request): boolean {
  const token = ADMIN_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function unauthorized() {
  return json({ error: "Unauthorized" }, { status: 401 });
}

// ---- Config caching -------------------------------------------------------
let cachedConfig: Config | null = null;
let cachedConfigTime = 0;
const CONFIG_CACHE_TTL = 5_000;

export function loadConfig(): Config {
  const now = Date.now();
  if (cachedConfig && (now - cachedConfigTime) < CONFIG_CACHE_TTL) return cachedConfig;

  const settings = db.getAllSettings();
  const configObj: any = {};
  for (const s of settings) {
    if (s.value === null) continue;
    try {
      configObj[s.key] = JSON.parse(s.value);
    } catch {
      configObj[s.key] = s.value;
    }
  }

  if (Object.keys(configObj).length === 0) {
    console.info("[config] No config found — applying defaults for fresh database");
    db.setSetting("defaultProvider", "tvdb");
    db.setSetting("onCollision", "skip");
    db.setSetting("dryRun", false);
    db.setSetting("seasonFolderFormat", "Season {season}");
    db.setSetting("apiKeys", {});
    db.setSetting("downloadClient", { type: "blackhole" });
    return loadConfig();
  }

  // Backfill: pre-v0.x the watch dir was stored under the orphaned "importFolder"
  // key. Fold it into blackhole.watchFolder so existing installs keep their setting.
  if (configObj.importFolder && typeof configObj.importFolder === 'string' && configObj.importFolder.trim()) {
    const dc = (configObj.downloadClient && typeof configObj.downloadClient === 'object' ? configObj.downloadClient : {});
    const bh = (dc.blackhole && typeof dc.blackhole === 'object' ? dc.blackhole : {});
    if (!bh.watchFolder) {
      bh.watchFolder = configObj.importFolder.trim();
      dc.blackhole = bh;
      configObj.downloadClient = dc;
    }
  }

  cachedConfig = ConfigSchema.parse(configObj);
  cachedConfigTime = now;

  // Blackhole is the built-in always-available download path. If the user
  // only configured one of its two folders, default the other: releases
  // grabbed without an external client are simply written into the folder
  // the blackhole watcher already ingests from.
  const bh = cachedConfig.downloadClient?.blackhole;
  if (bh) {
    if (!bh.outputFolder?.trim() && bh.watchFolder?.trim()) {
      bh.outputFolder = bh.watchFolder;
    } else if (!bh.watchFolder?.trim() && bh.outputFolder?.trim()) {
      bh.watchFolder = bh.outputFolder;
    }
  }

  return cachedConfig;
}

export function invalidateConfigCache() {
  cachedConfig = null;
}

// ---- Helpers --------------------------------------------------------------

export function isProviderType(value: string): value is ProviderType {
  return value === "tmdb" || value === "tvdb" || value === "anilist";
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function errorResponse(err: unknown, status = 400) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] ${message}`);
  return json({ error: message }, { status });
}

export function toIsoUtc(sqliteTimestamp: string): string {
  if (!sqliteTimestamp) return sqliteTimestamp;
  if (sqliteTimestamp.includes('T') || sqliteTimestamp.endsWith('Z')) return sqliteTimestamp;
  return `${sqliteTimestamp.replace(' ', 'T')}Z`;
}

// ---- Poster resolution ----------------------------------------------------

export function extractPosterUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      return metadata.image ?? metadata.artworks?.[0]?.image ?? null;
    case "tmdb":
      return metadata.poster_path ? `https://image.tmdb.org/t/p/w500${metadata.poster_path}` : null;
    case "anilist":
      return metadata.coverImage?.large ?? metadata.coverImage?.medium ?? null;
    default:
      return null;
  }
}

export function extractBackdropUrl(providerType: ProviderType, metadata: any): string | null {
  if (!metadata) return null;
  switch (providerType) {
    case "tvdb":
      const fanart = metadata.artworks?.find((a: any) => a.type === 15 || a.type === 3);
      return fanart?.image ?? null;
    case "tmdb":
      return metadata.backdrop_path ? `https://image.tmdb.org/t/p/w1280${metadata.backdrop_path}` : null;
    case "anilist":
      return metadata.bannerImage ?? null;
    default:
      return null;
  }
}

// ---- Client getters -------------------------------------------------------

export function getProwlarrIndexer() {
  const raw = db.getSetting('prowlarr');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = ProwlarrConfigSchema.parse(parsed);
    if (!config.enabled) return null;
    return IndexerFactory.create('prowlarr', config);
  } catch (err) {
    console.error('[api] Prowlarr is configured but invalid:', err);
    return null;
  }
}

export function getSonarrClient(): SonarrClient | null {
  const raw = db.getSetting('sonarr');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = SonarrConfigSchema.parse(parsed);
    if (!config.enabled || !config.baseUrl || !config.apiKey) return null;
    return new SonarrClient(config.baseUrl, config.apiKey, config.apiVersion);
  } catch (err) {
    console.error('[api] Sonarr is configured but invalid:', err);
    return null;
  }
}

export function getJellyfinClient(): JellyfinClient | null {
  const raw = db.getSetting('jellyfin');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const config = JellyfinConfigSchema.parse(parsed);
    if (!config.enabled || !config.baseUrl || !config.apiKey) return null;
    return new JellyfinClient(config.baseUrl, config.apiKey);
  } catch (err) {
    console.error('[api] Jellyfin is configured but invalid:', err);
    return null;
  }
}

export function getNativeIndexers(): { config: NativeIndexerConfig; instance: ReturnType<typeof IndexerFactory.createNative> }[] {
  const raw = db.getSetting('nativeIndexers');
  if (!raw) return [];
  try {
    const configs: NativeIndexerConfig[] = JSON.parse(typeof raw === 'string' ? raw : raw);
    return configs
      .filter(c => c.enabled)
      .map(c => ({ config: c, instance: IndexerFactory.createNative(c) }));
  } catch (err) {
    console.error('[api] Native indexers config is invalid:', err);
    return [];
  }
}

// ---- Release serialization -----------------------------------------------

export function serializeRelease({ indexer, ...rest }: any) {
  return rest;
}

// ---- Constants ------------------------------------------------------------

export type RouteReq = Request & { params: Record<string, string> };

export const NO_SIGNAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
  <rect width="500" height="750" fill="oklch(0.19 0.025 265)"/>
  <rect x="0.5" y="0.5" width="499" height="749" fill="none" stroke="oklch(1 0 0 / 10%)"/>
  <circle cx="250" cy="345" r="28" fill="none" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <line x1="230" y1="325" x2="270" y2="365" stroke="oklch(0.65 0.02 265)" stroke-width="2"/>
  <text x="250" y="410" font-family="ui-monospace, monospace" font-size="15" fill="oklch(0.65 0.02 265)" text-anchor="middle">NO SIGNAL</text>
</svg>`;
