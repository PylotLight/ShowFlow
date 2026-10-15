import { RefreshCwIcon } from "lucide-react";
import * as React from "react";

/**
 * Turn a raw fetch failure ("502", "Error: Server returned 503",
 * "TypeError: Failed to fetch") into a sentence a person can act on.
 */
export function describeFetchError(raw: unknown, what = "this"): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const code = Number(text.match(/\b([45]\d\d)\b/)?.[1]);
  if (code === 401 || code === 403) return `ShowFlow isn't allowed to load ${what} (HTTP ${code}). Check the admin token or sign in again.`;
  if (code === 404) return `ShowFlow couldn't find ${what} (HTTP 404). This build may not include it.`;
  if (code === 502 || code === 503 || code === 504) {
    return `Couldn't reach the service behind ${what} (HTTP ${code}). It may be offline or still starting up.`;
  }
  if (code >= 500) return `The server hit an error loading ${what} (HTTP ${code}).`;
  if (/failed to fetch|networkerror|load failed/i.test(text)) return `Couldn't connect to ShowFlow to load ${what}. Check your connection.`;
  return text ? `Couldn't load ${what}: ${text.replace(/^Error:\s*/, "")}` : `Couldn't load ${what}.`;
}

/** Readable error box with a Retry button. */
export function ErrorNotice({ error, what, onRetry }: { error: unknown; what?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-red-900/20 p-3">
      <p className="min-w-0 flex-1 text-sub text-red-300">{describeFetchError(error, what)}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-red-400/30 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-400/10 outline-none focus-visible:ring-2 focus-visible:ring-red-300/70"
        >
          <RefreshCwIcon className="size-3.5" /> Retry
        </button>
      )}
    </div>
  );
}
