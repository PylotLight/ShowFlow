import * as React from "react";

/**
 * Tiny hash router. Hash routing means the server keeps serving index.html
 * at "/*" untouched, while refresh / back / forward / deep links all work.
 *
 *   #/dashboard  #/calendar  #/library  #/pipeline  #/search
 *   #/activity  #/activity/:tab   (now | history | manual-import | health)
 *   #/settings  #/settings/:tab  (optional ?section=<id> to scroll to)
 *   #/show/:id   (show detail, rendered over the page you came from)
 *
 * Legacy pages redirect: #/queue -> #/activity/now, #/history,
 * #/manual-import, #/health -> the matching Activity tab, #/sources ->
 * #/settings/sources, #/settings?tab=health -> #/activity/health.
 *
 * Unknown or empty hashes resolve to the dashboard.
 */

// Internal page ids (kept identical to Sidebar's NavItem so nothing else has
// to change). "agenda" is the calendar page; its URL is #/calendar.
export type PageId =
  | "dashboard"
  | "agenda"
  | "activity"
  | "library"
  | "pipeline"
  | "search"
  | "settings";

export const PAGE_LABELS: Record<PageId, string> = {
  dashboard: "Dashboard",
  agenda: "Calendar",
  activity: "Activity",
  library: "Library",
  pipeline: "Pipeline",
  search: "Indexer Search",
  settings: "Settings",
};

/** Tabs of the Activity page, in display order. First one is the default. */
export const ACTIVITY_TABS = [
  { id: "now", label: "Now" },
  { id: "history", label: "History" },
  { id: "manual-import", label: "Manual Import" },
  { id: "health", label: "Health" },
] as const;
export type ActivityTab = (typeof ACTIVITY_TABS)[number]["id"];
export const DEFAULT_ACTIVITY_TAB: ActivityTab = "now";

function isActivityTab(t: string | undefined | null): t is ActivityTab {
  return !!t && ACTIVITY_TABS.some((x) => x.id === t);
}

const PAGE_TO_PATH: Record<PageId, string> = {
  dashboard: "dashboard",
  agenda: "calendar",
  activity: "activity",
  library: "library",
  pipeline: "pipeline",
  search: "search",
  settings: "settings",
};

const PATH_TO_PAGE: Record<string, PageId> = {
  ...Object.fromEntries(Object.entries(PAGE_TO_PATH).map(([page, path]) => [path, page as PageId])),
  agenda: "agenda",
};

/** Old top-level pages that now live inside Activity or Settings. */
const LEGACY_REDIRECTS: Record<string, PageRoute> = {
  queue: { kind: "page", page: "activity", activityTab: "now" },
  history: { kind: "page", page: "activity", activityTab: "history" },
  "manual-import": { kind: "page", page: "activity", activityTab: "manual-import" },
  health: { kind: "page", page: "activity", activityTab: "health" },
  sources: { kind: "page", page: "settings", settingsTab: "sources" },
};

export type PageRoute = { kind: "page"; page: PageId; settingsTab?: string; section?: string; activityTab?: ActivityTab };
export type Route = PageRoute | { kind: "show"; showId: string };

export const DEFAULT_ROUTE: Route = { kind: "page", page: "dashboard" };

/** True for any first path segment the router understands (incl. redirects). */
export function isKnownPath(head: string): boolean {
  return head === "show" || !!PATH_TO_PAGE[head] || !!LEGACY_REDIRECTS[head];
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const query = new URLSearchParams(queryPart);
  const [head, second] = segments;
  if (!head) return DEFAULT_ROUTE;

  if (head === "show") {
    return second ? { kind: "show", showId: second } : DEFAULT_ROUTE;
  }

  const legacy = LEGACY_REDIRECTS[head];
  if (legacy) return { ...legacy };

  const page = PATH_TO_PAGE[head];
  if (!page) return DEFAULT_ROUTE;

  if (page === "settings") {
    // Accept both #/settings/indexers and the legacy #/settings?tab=indexers.
    const settingsTab = second ?? query.get("tab") ?? undefined;
    // Health used to be linked as a settings tab; it lives in Activity now.
    if (settingsTab === "health") return { kind: "page", page: "activity", activityTab: "health" };
    const section = query.get("section") ?? undefined;
    return { kind: "page", page, ...(settingsTab ? { settingsTab } : {}), ...(section ? { section } : {}) };
  }
  if (page === "activity") {
    const tab = second ?? query.get("tab");
    return { kind: "page", page, activityTab: isActivityTab(tab) ? tab : DEFAULT_ACTIVITY_TAB };
  }
  return { kind: "page", page };
}

export function routeToHash(route: Route): string {
  if (route.kind === "show") return `#/show/${encodeURIComponent(route.showId)}`;
  let hash = `#/${PAGE_TO_PATH[route.page]}`;
  if (route.page === "settings" && route.settingsTab) {
    hash += `/${encodeURIComponent(route.settingsTab)}`;
    if (route.section) hash += `?section=${encodeURIComponent(route.section)}`;
  }
  if (route.page === "activity") {
    hash += `/${route.activityTab ?? DEFAULT_ACTIVITY_TAB}`;
  }
  return hash;
}

export function pageHash(page: PageId, settingsTab?: string, section?: string): string {
  return routeToHash({ kind: "page", page, settingsTab, section });
}

export function activityHash(tab: ActivityTab = DEFAULT_ACTIVITY_TAB): string {
  return routeToHash({ kind: "page", page: "activity", activityTab: tab });
}

/**
 * Turns an in-app link from the server (notifications / background jobs send
 * things like "/queue" or "/settings?tab=health") into a hash. Returns null
 * for anything that isn't an app route (external URLs, /api/…).
 */
export function linkToHash(link: string): string | null {
  if (link.startsWith("#/")) return routeToHash(parseHash(link));
  if (!link.startsWith("/") || link.startsWith("//") || link.startsWith("/api/")) return null;
  const [path = "", query = ""] = link.slice(1).split("?");
  const head = path.split("/")[0] ?? "";
  if (!isKnownPath(head)) return null;
  return routeToHash(parseHash(`#/${path}${query ? `?${query}` : ""}`));
}

/**
 * Go to a hash route. `replace` swaps the current history entry instead of
 * pushing; `state` is stored on the new entry (used to tell "opened from
 * inside the app" apart from a pasted deep link).
 */
export function navigate(hash: string, opts: { replace?: boolean; state?: unknown } = {}) {
  if (typeof window === "undefined") return;
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (opts.replace) {
    window.history.replaceState(opts.state ?? null, "", url);
  } else {
    window.history.pushState(opts.state ?? null, "", url);
  }
  // push/replaceState don't fire hashchange — notify subscribers ourselves.
  // (Back / forward between hash entries does fire it natively.)
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** True when the current history entry was pushed by an in-app navigation. */
export function cameFromApp(): boolean {
  const s = typeof window !== "undefined" ? window.history.state : null;
  return !!(s && typeof s === "object" && (s as { sfFromApp?: boolean }).sfFromApp);
}

/** Navigate to a server-provided link, in-app when possible. */
export function openAppLink(link: string) {
  const hash = linkToHash(link);
  if (hash) navigate(hash);
  else window.location.assign(link);
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function getHash() {
  return window.location.hash;
}

/** Current route, re-rendering on hashchange (incl. back / forward). */
export function useHashRoute(): Route {
  const hash = React.useSyncExternalStore(subscribe, getHash, () => "");
  return React.useMemo(() => parseHash(hash), [hash]);
}
