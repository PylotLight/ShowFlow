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
  | 'metadata_provider'
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
  /**
   * Human-readable suggestion of what the user should do to fix the issue.
   * Shown in the §3 failure diagnosis panel alongside the label.
   */
  suggestedAction: string;
}

export const REASON_CODES = {
  // ---- Search / indexer ----
  NO_INDEXERS_CONFIGURED: { category: 'config', label: 'No indexers configured', confidence: 'certain', suggestedAction: 'Go to Settings > Indexers and connect Prowlarr or enable a native indexer.' },
  INDEXER_SEARCH_ERROR: { category: 'indexer', label: 'Indexer returned an error', confidence: 'certain', suggestedAction: 'Check your indexer configuration in Settings > Indexers and verify the connection.' },
  INDEXER_UNREACHABLE: { category: 'indexer', label: 'Indexer unreachable or rejected credentials', confidence: 'certain', suggestedAction: 'Verify the indexer URL and API key in Settings > Indexers, then test the connection.' },
  NO_RESULTS_FOUND: { category: 'indexer', label: 'No results found', confidence: 'certain', suggestedAction: 'The release may not be available yet. Wait for the episode to air or check that your indexers cover this content.' },

  // ---- Download clients / disk ----
  DOWNLOAD_CLIENT_UNREACHABLE: { category: 'download_client', label: 'Download client unreachable or rejected credentials', confidence: 'certain', suggestedAction: 'Check your download client settings in Settings > Downloads and verify the connection.' },
  WATCH_FOLDER_UNAVAILABLE: { category: 'disk_permissions', label: 'Watch folder missing or not writable', confidence: 'certain', suggestedAction: 'Ensure the watch folder path exists and the application has write permissions. Check Settings > Downloads.' },
  IMPORT_PATH_UNAVAILABLE: { category: 'disk_permissions', label: 'Import/root folder missing or not writable', confidence: 'certain', suggestedAction: 'Ensure the root folder path exists and the application has write permissions. Update the path in the show profile settings.' },

  // ---- Filtering (before quality scoring) ----
  TITLE_OR_SEASON_MISMATCH: { category: 'naming_mismatch', label: "Doesn't match show, season, or episode", confidence: 'certain', suggestedAction: 'The release title could not be matched to a tracked episode. This is usually a naming issue with the release group.' },

  // ---- Quality profile rejection ----
  FORBIDDEN_FORMAT_MATCHED: { category: 'release_quality', label: 'Matched a forbidden format', confidence: 'certain', suggestedAction: 'The release format is in your forbidden list. Adjust your quality profile in Settings > Quality to allow it, or wait for a different release.' },
  MISSING_REQUIRED_FORMAT: { category: 'release_quality', label: 'Missing a required format', confidence: 'certain', suggestedAction: 'The release is missing a format you marked as required. Adjust your quality profile in Settings > Quality.' },
  QUALITY_NOT_ALLOWED: { category: 'release_quality', label: "Quality not in this profile's allow-list", confidence: 'certain', suggestedAction: 'The release quality is outside your profile preferences. Adjust your quality profile in Settings > Quality, or wait for a different release.' },
  QUALITY_UNKNOWN: { category: 'release_quality', label: 'Could not identify a quality for this release', confidence: 'likely', suggestedAction: 'The release format could not be identified. This may be an unusual encode; try a different release group.' },
  NOT_AN_UPGRADE: { category: 'release_quality', label: 'Not an upgrade over the existing file', confidence: 'certain', suggestedAction: 'The release quality is lower than or equal to what you already have. No action needed unless you want to replace it manually.' },

  // ---- Metadata providers ----
  METADATA_PROVIDER_UNREACHABLE: { category: 'metadata_provider', label: 'Metadata provider unreachable', confidence: 'certain', suggestedAction: 'Check your network/DNS for a block on the metadata provider domain (e.g. thexem.info). If a proxy is required, ensure it is configured and the app honors it.' },

  // ---- Grab ----
  GRAB_FAILED_NO_CLIENT: { category: 'download_client', label: 'Grab failed - check download client configuration', confidence: 'certain', suggestedAction: 'Check your download client settings in Settings > Downloads. Ensure the client is enabled and credentials are correct.' },
  GRAB_FAILED_INDEXER: { category: 'indexer', label: 'Indexer rejected the grab request', confidence: 'certain', suggestedAction: 'The indexer rejected the download request. Check the indexer status in Settings > Indexers.' },
  GRAB_SUCCEEDED: { category: 'success', label: 'Sent to download client', confidence: 'certain', suggestedAction: 'No action needed. The release was sent to your download client.' },
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
