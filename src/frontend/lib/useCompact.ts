import * as React from "react";

/**
 * The compact (phone / mini-window) layout kicks in below the `md`
 * breakpoint, the same width the bottom tab bar appears at, so every page
 * switches to its mobile layout in lockstep with the app chrome.
 */
export const COMPACT_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(COMPACT_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot() {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(COMPACT_QUERY).matches;
}

/** True while the viewport is phone-sized (< 768px wide). */
export function useCompact(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}
