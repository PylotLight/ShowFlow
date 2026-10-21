/**
 * "Go to this setting": switch to its tab, wait for the row to render, scroll
 * it into view below the sticky section bar, and flash it.
 *
 * Settings search and the ⌘K palette call `requestSettingFocus`. If the
 * Settings page is mounted it handles the event straight away; otherwise the
 * request waits in `pending` and SettingsPage picks it up when it mounts.
 */

import { navigate, pageHash } from "@frontend/lib/router";
import { findSetting, type SettingMeta } from "./registry";

export const SETTING_FOCUS_EVENT = "showflow:setting-focus";

export interface SettingFocusRequest { tab: string; id: string }

let pending: SettingFocusRequest | null = null;
let mounted = 0;

/** SettingsPage registers while mounted so requests skip the pending slot. */
export function registerSettingsPage(): () => void {
  mounted++;
  return () => { mounted--; };
}

export function peekPendingSettingFocus(): SettingFocusRequest | null {
  return pending;
}

export function takePendingSettingFocus(): SettingFocusRequest | null {
  const p = pending;
  pending = null;
  return p;
}

export function requestSettingFocus(entry: Pick<SettingMeta, "tab" | "id">) {
  // Stored even when the page is mounted: switching tabs can remount it
  // (a ?section= URL keys the page), and the new instance picks it up.
  pending = { tab: entry.tab, id: entry.id };
  if (mounted > 0) {
    window.dispatchEvent(new CustomEvent<SettingFocusRequest>(SETTING_FOCUS_EVENT, { detail: pending }));
  } else {
    navigate(pageHash("settings", entry.tab));
  }
}

function attrSelector(id: string) {
  return `[data-setting="${id.replace(/["\\]/g, "\\$&")}"]`;
}

/** Element for a registry id (its anchor, then its fallback), or a plain DOM id. */
export function findSettingElement(id: string, root: ParentNode = document): HTMLElement | null {
  if (id.startsWith("tab:")) return null;
  const meta = findSetting(id);
  const candidates = meta ? [meta.anchor ?? meta.id, meta.fallback] : [id];
  for (const c of candidates) {
    if (!c) continue;
    const el = root.querySelector<HTMLElement>(attrSelector(c));
    if (el && el.getClientRects().length) return el;
  }
  // Legacy ?section= deep links use bare ids ("updates", "libraries").
  if (!meta) {
    try {
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (el) return el;
    } catch { /* invalid selector */ }
  }
  return null;
}

export function scrollParent(el: HTMLElement): HTMLElement {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/** Height of whatever sticks to the top of this scroller (the section bar). */
export function stickyOffset(scroller: HTMLElement): number {
  const bar = scroller.querySelector<HTMLElement>("[data-settings-subnav]");
  return bar ? bar.getBoundingClientRect().height : 0;
}

/** Scroll `el` to just under the sticky section bar of its scroller. */
export function scrollToSettingElement(el: HTMLElement, behavior: ScrollBehavior = "smooth") {
  const scroller = scrollParent(el);
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // The bar sticks flush at the scroller's top edge (it cancels the padding),
  // so land the target a small gap below the bar's bottom.
  scroller.scrollTo({ top: Math.max(0, top - stickyOffset(scroller) - 16), behavior: reduce ? "auto" : behavior });
}

const flashTimers = new WeakMap<HTMLElement, number>();

export function flashSettingElement(el: HTMLElement) {
  const prev = flashTimers.get(el);
  if (prev) window.clearTimeout(prev);
  el.classList.add("setting-flash");
  flashTimers.set(el, window.setTimeout(() => { el.classList.remove("setting-flash"); flashTimers.delete(el); }, 1400));
}

/**
 * Poll for the target (tabs load their data async) for up to `timeoutMs`,
 * then scroll + flash. Returns a cancel function.
 */
export function focusSettingWhenReady(id: string, timeoutMs = 4000): () => void {
  // A whole-tab result: the tab switch is the destination.
  if (id.startsWith("tab:")) return () => {};
  let cancelled = false;
  const start = performance.now();
  const tick = () => {
    if (cancelled) return;
    const el = findSettingElement(id);
    if (el) {
      scrollToSettingElement(el);
      flashSettingElement(el);
      // Move focus to the row's first control for keyboard users, without a
      // second scroll jump. Not on touch: an input there pops the keyboard.
      const ctl = el.querySelector<HTMLElement>("input:not([type=hidden]), button, select, textarea, [role=switch]");
      if (ctl && !window.matchMedia?.("(pointer: coarse)").matches) ctl.focus({ preventScroll: true });
      return;
    }
    if (performance.now() - start < timeoutMs) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { cancelled = true; };
}
