import { test, expect } from "bun:test";
import { isLocalView, localViewBlocks, applyLocalViewGuard } from "./local_view";

test("flag parsing", () => {
  expect(isLocalView({})).toBe(false);
  expect(isLocalView({ SHOWFLOW_LOCAL_VIEW: "0" })).toBe(false);
  expect(isLocalView({ SHOWFLOW_LOCAL_VIEW: "1" })).toBe(true);
  expect(isLocalView({ SHOWFLOW_LOCAL_VIEW: "true" })).toBe(true);
});

test("plain reads pass", () => {
  for (const p of ["/api/shows", "/api/shows/:id", "/api/shows/:id/episodes", "/api/calendar", "/api/history",
    "/api/images/poster/:source/:id", "/api/system/status", "/api/tasks", "/api/backup", "/api/backup/summary",
    "/api/providers/:source/search"]) {
    expect(localViewBlocks("GET", p)).toBe(false);
  }
});

test("mutations are refused", () => {
  expect(localViewBlocks("POST", "/api/shows")).toBe(true);
  expect(localViewBlocks("DELETE", "/api/shows/:id")).toBe(true);
  expect(localViewBlocks("PUT", "/api/settings")).toBe(true);
  expect(localViewBlocks("POST", "/api/tasks/:name")).toBe(true);
  expect(localViewBlocks("POST", "/api/backup")).toBe(true);
  expect(localViewBlocks("POST", "/api/naming/preview")).toBe(false);
});

test("outbound reads are refused", () => {
  for (const p of ["/api/search", "/api/search/adhoc", "/api/indexers/prowlarr/status",
    "/api/shows/:id/seasons/:season/search", "/api/shows/:id/seasons/:season/episodes/:episode/search",
    "/api/shows/:id/movie/search", "/api/sonarr/series", "/api/jellyfin/users", "/api/manual-import/list",
    "/api/admin/updates/available", "/api/admin/updates/check", "/api/backups/:file"]) {
    expect(localViewBlocks("GET", p)).toBe(true);
  }
});

test("non-api routes untouched", () => {
  expect(localViewBlocks("POST", "/internal/ready")).toBe(false);
  expect(localViewBlocks("GET", "/*")).toBe(false);
});

test("guard swaps blocked handlers for a 403", async () => {
  const ok = () => new Response("ok");
  const defs = applyLocalViewGuard({ "/api/shows": { GET: ok, POST: ok } }) as any;
  expect(await defs["/api/shows"].GET().text()).toBe("ok");
  expect(defs["/api/shows"].POST().status).toBe(403);
});
