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
    expect(parseHash("#/manual-import")).toEqual({ kind: "page", page: "manual-import" });
    expect(parseHash("#/calendar")).toEqual({ kind: "page", page: "agenda" });
    expect(parseHash("#/agenda")).toEqual({ kind: "page", page: "agenda" });
  });

  test("settings tab + section, incl legacy ?tab=", () => {
    expect(parseHash("#/settings")).toEqual({ kind: "page", page: "settings" });
    expect(parseHash("#/settings/indexers")).toEqual({ kind: "page", page: "settings", settingsTab: "indexers" });
    expect(parseHash("#/settings?tab=health")).toEqual({ kind: "page", page: "settings", settingsTab: "health" });
    expect(parseHash("#/settings/general?section=updates")).toEqual({ kind: "page", page: "settings", settingsTab: "general", section: "updates" });
  });

  test("show", () => {
    expect(parseHash("#/show/abc-123")).toEqual({ kind: "show", showId: "abc-123" });
    expect(parseHash("#/show/a%20b")).toEqual({ kind: "show", showId: "a b" });
  });
});

test("routeToHash round-trips", () => {
  for (const h of ["#/dashboard", "#/calendar", "#/queue", "#/settings/debug", "#/settings/general?section=updates", "#/show/x1"]) {
    expect(routeToHash(parseHash(h))).toBe(h);
  }
});

test("linkToHash maps server links", () => {
  expect(linkToHash("/queue")).toBe("#/queue");
  expect(linkToHash("/settings?tab=health")).toBe("#/settings/health");
  expect(linkToHash("/settings?tab=general")).toBe("#/settings/general");
  expect(linkToHash("#/library")).toBe("#/library");
  expect(linkToHash("https://example.com")).toBeNull();
  expect(linkToHash("/api/foo")).toBeNull();
  expect(linkToHash("/unknown")).toBeNull();
});
