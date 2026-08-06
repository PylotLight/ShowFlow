import { test, expect } from "bun:test";
import { formatAirtime } from "./airtime";

test("formats an ISO timestamp to local time", () => {
  const out = formatAirtime("2026-08-07T20:30:00.000Z");
  expect(out).toBe(new Date("2026-08-07T20:30:00.000Z").toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
});

test("returns empty for date-only strings (no T)", () => {
  expect(formatAirtime("2026-08-07")).toBe("");
});

test("returns empty for null/undefined/garbage", () => {
  expect(formatAirtime(null)).toBe("");
  expect(formatAirtime(undefined)).toBe("");
  expect(formatAirtime("not-a-date")).toBe("");
});