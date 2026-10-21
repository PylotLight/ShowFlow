import { db } from '../db';

/**
 * Why the watch-folder importer left a file behind, recorded at the moment
 * it declined (not an upgrade, duplicate, unmatched, collision, error ...).
 *
 * Manual Import used to show a bare "Resolved" badge, so a file sitting in
 * the watch folder gave no hint why. The importer now writes the real
 * decision here, keyed by the file's full watch-folder path, and the Manual
 * Import list reads it back (falling back to re-deriving the reason for
 * files declined before this existed).
 *
 * Stored as one JSON map in `settings` next to the manual-hold list it
 * mirrors. Bounded: oldest entries are dropped past MAX_ENTRIES, and an entry
 * is removed as soon as the file is imported or deleted.
 */

export type ManualImportReasonCode =
  | 'NOT_AN_UPGRADE'
  | 'CUTOFF_MET'
  | 'UPGRADES_OFF'
  | 'REJECTED_BY_PROFILE'
  | 'SAMPLE'
  | 'DUPLICATE'
  | 'UNMATCHED'
  | 'PARSE_FAILED'
  | 'NO_ROOT_FOLDER'
  | 'NO_PROFILE'
  | 'COLLISION'
  | 'IMPORT_ERROR'
  | 'IN_PROGRESS'
  | 'UPGRADE_WAITING'
  | 'NEW_WAITING';

export interface RecordedReason {
  code: ManualImportReasonCode;
  message: string;
  /** ISO timestamp of the decision. */
  at: string;
  /** Incoming file size at decision time; a different size means a new file landed under the same name. */
  size?: number | null;
  /** Scores at decision time (NOT_AN_UPGRADE / CUTOFF_MET). */
  incomingScore?: number;
  existingScore?: number;
  existingFilename?: string;
}

const KEY = 'blackhole.manual_hold_reasons';
export const MAX_ENTRIES = 500;

function readAll(): Record<string, RecordedReason> {
  const raw = db.getSetting(KEY);
  if (!raw) return {};
  try {
    const obj = JSON.parse(String(raw));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, RecordedReason>) {
  if (Object.keys(map).length === 0) db.removeSetting(KEY);
  else db.setSetting(KEY, map);
}

export function recordImportReason(fullPath: string, reason: Omit<RecordedReason, 'at'> & { at?: string }): void {
  try {
    const map = readAll();
    delete map[fullPath];
    map[fullPath] = { ...reason, at: reason.at ?? new Date().toISOString() };
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      // Insertion order = recency (we delete-then-set above).
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    writeAll(map);
  } catch (err) {
    // Explaining a decline must never break the import itself.
    console.warn('[manual-import] could not record decline reason:', err);
  }
}

/** The recorded reason for a file, or null when none / it no longer matches the file on disk. */
export function getImportReason(fullPath: string, currentSize?: number | null): RecordedReason | null {
  const r = readAll()[fullPath];
  if (!r) return null;
  if (r.size != null && currentSize != null && r.size !== currentSize) return null;
  return r;
}

export function clearImportReason(fullPath: string): void {
  try {
    const map = readAll();
    if (!(fullPath in map)) return;
    delete map[fullPath];
    writeAll(map);
  } catch {}
}

export function clearAllImportReasons(): void {
  try { db.removeSetting(KEY); } catch {}
}

/** Drop entries for files no longer in the watch folder (called from the listing). */
export function pruneImportReasons(keep: Set<string>): void {
  try {
    const map = readAll();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (!keep.has(k)) { delete map[k]; changed = true; }
    }
    if (changed) writeAll(map);
  } catch {}
}
