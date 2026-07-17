/**
 * Shared reason-code taxonomy for the pipeline event log.
 *
 * Every pipeline_events row that represents a rejection, filter, or failure
 * carries one of these codes. This is the single source of truth referenced
 * by:
 *   - the "why isn't this downloading yet" trace (per-item event history)
 *   - the Failure Diagnosis Assistant (translates a code into plain English
 *     + a suggested action)
 *   - the health dashboard (system-level events use the same categories)
 *
 * Keep categories stable - they're a contract shared across those UI
 * surfaces. Add new codes freely; don't repurpose an existing one for a
 * different meaning, since old rows in the DB keep whatever code they were
 * written with.
 */

export type ReasonCategory =
  | 'indexer'
  | 'download_client'
  | 'disk_permissions'
  | 'release_quality'
  | 'naming_mismatch'
  | 'network'
  | 'config'
  | 'success';

export interface ReasonCodeDef {
  category: ReasonCategory;
  /** Short, plain-English label suitable for a trace line or badge. */
  label: string;
  /**
   * §3 "Confidence": certain = deterministic from the error/data itself,
   * likely = a well-supported inference, guess = heuristic/best-effort.
   * Everything defined here today is 'certain' - all rules-based, per the
   * brief's recommendation to ship (1) rules-based before any (2)
   * heuristic/ML-assisted diagnoses. Leave room for 'guess' codes later,
   * but never silently upgrade a guess to certain.
   */
  confidence: 'certain' | 'likely' | 'guess';
}

export const REASON_CODES = {
  // ---- Search / indexer ----
  NO_INDEXERS_CONFIGURED: { category: 'config', label: 'No indexers configured', confidence: 'certain' },
  INDEXER_SEARCH_ERROR: { category: 'indexer', label: 'Indexer returned an error', confidence: 'certain' },
  INDEXER_UNREACHABLE: { category: 'indexer', label: 'Indexer unreachable or rejected credentials', confidence: 'certain' },
  NO_RESULTS_FOUND: { category: 'indexer', label: 'No results found', confidence: 'certain' },

  // ---- Download clients / disk ----
  DOWNLOAD_CLIENT_UNREACHABLE: { category: 'download_client', label: 'Download client unreachable or rejected credentials', confidence: 'certain' },
  WATCH_FOLDER_UNAVAILABLE: { category: 'disk_permissions', label: 'Watch folder missing or not writable', confidence: 'certain' },
  IMPORT_PATH_UNAVAILABLE: { category: 'disk_permissions', label: 'Import/root folder missing or not writable', confidence: 'certain' },

  // ---- Filtering (before quality scoring) ----
  TITLE_OR_SEASON_MISMATCH: { category: 'naming_mismatch', label: "Doesn't match show, season, or episode", confidence: 'certain' },

  // ---- Quality profile rejection ----
  FORBIDDEN_FORMAT_MATCHED: { category: 'release_quality', label: 'Matched a forbidden format', confidence: 'certain' },
  MISSING_REQUIRED_FORMAT: { category: 'release_quality', label: 'Missing a required format', confidence: 'certain' },
  QUALITY_NOT_ALLOWED: { category: 'release_quality', label: "Quality not in this profile's allow-list", confidence: 'certain' },
  QUALITY_UNKNOWN: { category: 'release_quality', label: 'Could not identify a quality for this release', confidence: 'likely' },
  NOT_AN_UPGRADE: { category: 'release_quality', label: 'Not an upgrade over the existing file', confidence: 'certain' },

  // ---- Grab ----
  GRAB_FAILED_NO_CLIENT: { category: 'download_client', label: 'Grab failed - check download client configuration', confidence: 'certain' },
  GRAB_FAILED_INDEXER: { category: 'indexer', label: 'Indexer rejected the grab request', confidence: 'certain' },
  GRAB_SUCCEEDED: { category: 'success', label: 'Sent to download client', confidence: 'certain' },
} as const satisfies Record<string, ReasonCodeDef>;

export type ReasonCode = keyof typeof REASON_CODES;

export function describeReasonCode(code: ReasonCode | string | null | undefined): ReasonCodeDef | undefined {
  if (!code) return undefined;
  return (REASON_CODES as Record<string, ReasonCodeDef>)[code];
}

/**
 * Coarse pipeline stage - the column an item sits in on the Kanban view.
 * FAILED/STALLED is deliberately not a normal column per the brief (§1) -
 * it's represented as a `stage` value here so the trace/diagnosis layers
 * can still query it uniformly, but the UI should treat it as a pinned/
 * collapsible lane rather than a step in the main WANTED->AVAILABLE flow.
 */
export type PipelineStage =
  | 'WANTED'
  | 'SEARCHING'
  | 'GRABBED'
  | 'IMPORTING'
  | 'AVAILABLE'
  | 'FAILED';
