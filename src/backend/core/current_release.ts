// What release are we actually on? Normally just the compiled-in
// BUILD_VERSION, but v0.1.81 shipped stamped "main" (see build_stamp.ts), and
// with a non-version stamp the updater treated every tag as "not current" and
// re-installed the running release over itself (ETXTBSY). So when the stamp
// isn't a real version, fall back to the active release's manifest, then the
// tag recorded when that release was activated.

import { db } from "../db";
import { getActiveReleaseId } from "./updates_manager";
import { resolveCurrentVersion } from "./update_policy";

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== "undefined" ? __BUILD_COMMIT__ : "development";
const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "development";
const DATA_DIR = process.env.SHOWFLOW_DATA_DIR ?? "/data";

export interface CurrentRelease {
  /** Resolved release version (`v0.1.81`), or null when unknown. */
  version: string | null;
  /** The supervisor's active release dir (tarball sha), or our own commit. */
  releaseId: string | null;
  /** What to show in the UI: the resolved version, else the raw stamp. */
  display: string;
}

const TTL_MS = 60_000;
let cached: { at: number; value: CurrentRelease } | null = null;

async function manifestVersion(releaseId: string | null): Promise<string | null> {
  if (!releaseId || releaseId.includes("/") || releaseId.includes("..")) return null;
  try {
    const f = Bun.file(`${DATA_DIR}/releases/${releaseId}/manifest.json`);
    if (!(await f.exists())) return null;
    const m = (await f.json()) as { version?: unknown };
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

function activatedTag(releaseId: string | null): string | null {
  if (!releaseId) return null;
  try {
    const raw = db.getSetting("updates:lastActivation");
    const a = typeof raw === "string" ? JSON.parse(raw) : raw;
    return a && a.releaseId === releaseId && typeof a.tag === "string" ? a.tag : null;
  } catch {
    return null;
  }
}

export async function getCurrentRelease(opts: { fresh?: boolean } = {}): Promise<CurrentRelease> {
  if (!opts.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const releaseId = (await getActiveReleaseId()) ?? (BUILD_COMMIT !== "development" ? BUILD_COMMIT : null);
  let version = resolveCurrentVersion([BUILD_VERSION]);
  if (!version) version = resolveCurrentVersion([await manifestVersion(releaseId), activatedTag(releaseId)]);
  const value: CurrentRelease = { version, releaseId, display: version ?? BUILD_VERSION };
  cached = { at: Date.now(), value };
  return value;
}
