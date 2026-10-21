import { test, expect } from "bun:test";
import { unavailableResponse } from "./proxy";

test("unavailableResponse is a JSON 503 flagged as restarting, with Retry-After", async () => {
  const res = unavailableResponse("quiescing");
  expect(res.status).toBe(503);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("retry-after")).toBe("2");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body).toMatchObject({ error: "Service Unavailable", restarting: true, phase: "quiescing" });
});

test("unavailableResponse without a phase still parses as JSON", async () => {
  const body = await unavailableResponse().json();
  expect(body.restarting).toBe(true);
  expect(body.phase).toBeNull();
});
