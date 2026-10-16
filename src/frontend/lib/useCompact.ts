import * as React from "react";

/**
 * The compact (phone / mini-window) layout kicks in wherever the `md`
 * variant is off: below 768px wide, or on a short touch screen (a phone in
 * landscape, <= 31.2rem tall), the same switch as the bottom tab bar, so every
 * page changes layout in lockstep with the app chrome. Keep in sync with the
 * md / max-md custom variants in styles/globals.css.
 */
export const COMPACT_QUERY = "(max-width: 767.98px), (pointer: coarse) and (max-height: 31.2rem)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(COMPACT_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot() {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(COMPACT_QUERY).matches;
}

/** True while the compact (phone) layout is active. */
export function useCompact(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}
