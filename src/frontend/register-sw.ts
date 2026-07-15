/**
 * Registers the navigation-only service worker (see sw.js) that keeps the
 * tab alive across the supervisor's stop/start release handoff.
 *
 * Also exports markPendingRelease(), which the eventual "activate update"
 * UI should call *before* POSTing /api/admin/updates/activate. It stashes
 * the target releaseId in localStorage so offline.html — served from the
 * cache while the old process is down — knows which release it's actually
 * waiting for, rather than reloading the instant it sees any 200 (which
 * could still be a restore-to-lastKnownGood after a failed activation).
 */

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[sw] registration failed", err);
    });
  });
}

export function markPendingRelease(releaseId: string): void {
  try {
    localStorage.setItem("showflow:pendingReleaseId", releaseId);
  } catch {
    // localStorage disabled/unavailable — offline.html just falls back to
    // reloading on the first 200 it sees instead of waiting for a match.
  }
}

export function clearPendingRelease(): void {
  try {
    localStorage.removeItem("showflow:pendingReleaseId");
  } catch {
    // no-op
  }
}
