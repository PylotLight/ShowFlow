import { test, expect, describe } from "bun:test";
import { parseHash, routeToHash, linkToHash, DEFAULT_ROUTE } from "./router";

describe("parseHash", () => {
  test("empty / unknown -> dashboard", () => {
    expect(parseHash("")).toEqual(DEFAULT_ROUTE);
    expect(parseHash("#/")).toEqual(DEFAULT_ROUTE);
    expect(parseHash("#/nope")).toEqual(DEFAULT_ROUTE);
    expect(parseHash("#/show")).toEqual(DEFAULT_ROUTE);
  });

  test("pages", () => {
    expect(parseHash("#/library")).toEqual({ kind: "page", page: "library" });
    expect(parseHash("#/activity")).toEqual({ kind: "page", page: "activity", activityTab: "now" });
    expect(parseHash("#/activity/history")).toEqual({ kind: "page", page: "activity", activityTab: "history" });
    expect(parseHash("#/activity/bogus")).toEqual({ kind: "page", page: "activity", activityTab: "now" });
    expect(parseHash("#/calendar")).toEqual({ kind: "page", page: "agenda" });
    expect(parseHash("#/agenda")).toEqual({ kind: "page", page: "agenda" });
  });

  test("settings tab + section, incl legacy ?tab=", () => {
    expect(parseHash("#/settings")).toEqual({ kind: "page", page: "settings" });
    expect(parseHash("#/settings/indexers")).toEqual({ kind: "page", page: "settings", settingsTab: "indexers" });
    expect(parseHash("#/settings?tab=indexers")).toEqual({ kind: "page", page: "settings", settingsTab: "indexers" });
    // health moved out of settings into Activity
    expect(parseHash("#/settings?tab=health")).toEqual({ kind: "page", page: "activity", activityTab: "health" });
    expect(parseHash("#/settings/general?section=updates")).toEqual({ kind: "page", page: "settings", settingsTab: "general", section: "updates" });
  });

  test("show", () => {
    expect(parseHash("#/show/abc-123")).toEqual({ kind: "show", showId: "abc-123" });
    expect(parseHash("#/show/a%20b")).toEqual({ kind: "show", showId: "a b" });
  });
});

describe("legacy redirects", () => {
  test("old pages land on Activity tabs / Settings", () => {
    expect(routeToHash(parseHash("#/queue"))).toBe("#/activity/now");
    expect(routeToHash(parseHash("#/history"))).toBe("#/activity/history");
    expect(routeToHash(parseHash("#/manual-import"))).toBe("#/activity/manual-import");
    expect(routeToHash(parseHash("#/health"))).toBe("#/activity/health");
    expect(routeToHash(parseHash("#/sources"))).toBe("#/settings/sources");
  });
});

test("routeToHash round-trips", () => {
  for (const h of ["#/dashboard", "#/calendar", "#/activity/now", "#/activity/manual-import", "#/settings/debug", "#/settings/general?section=updates", "#/show/x1"]) {
    expect(routeToHash(parseHash(h))).toBe(h);
  }
});

test("linkToHash maps server links", () => {
  expect(linkToHash("/queue")).toBe("#/activity/now");
  expect(linkToHash("/history")).toBe("#/activity/history");
  expect(linkToHash("/activity/health")).toBe("#/activity/health");
  expect(linkToHash("/sources")).toBe("#/settings/sources");
  expect(linkToHash("/settings?tab=health")).toBe("#/activity/health");
  expect(linkToHash("/settings?tab=general")).toBe("#/settings/general");
  expect(linkToHash("#/library")).toBe("#/library");
  expect(linkToHash("https://example.com")).toBeNull();
  expect(linkToHash("/api/foo")).toBeNull();
  expect(linkToHash("/unknown")).toBeNull();
});
