import { test, expect } from "bun:test";
import { formatAirtime, formatTime12, expectedReleaseTime, formatDelayMinutes, formatFileSize } from "./airtime";

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

test("formatTime12 formats + returns null for garbage", () => {
  expect(formatTime12("2026-08-07T20:30:00.000Z")).toBe(
    new Date("2026-08-07T20:30:00.000Z").toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true }),
  );
  expect(formatTime12(null)).toBeNull();
  expect(formatTime12("garbage")).toBeNull();
});

test("expectedReleaseTime prefers expectedReleaseAt, falls back to airDate", () => {
  expect(expectedReleaseTime("2026-08-07T21:00:00.000Z", null)).toBe(
    formatTime12("2026-08-07T21:00:00.000Z"),
  );
  expect(expectedReleaseTime(null, "2026-08-07T20:15:00.000Z")).toBe(
    formatTime12("2026-08-07T20:15:00.000Z"),
  );
  expect(expectedReleaseTime(null, null)).toBeNull();
});

test("formatDelayMinutes", () => {
  expect(formatDelayMinutes(45)).toBe("+45m");
  expect(formatDelayMinutes(60)).toBe("~1h");
  expect(formatDelayMinutes(75)).toBe("~1h 15m");
  expect(formatDelayMinutes(null)).toBeNull();
});

test("formatFileSize", () => {
  expect(formatFileSize(0)).toBe("");
  expect(formatFileSize(null)).toBe("");
  expect(formatFileSize(1024)).toBe("1 KB");
  expect(formatFileSize(2254857830)).toBe("2.1 GB");
});