import { test, expect } from 'bun:test';
import { isRssHealthy, autoGrabIntervalMinutes, shouldRunAutoGrab, type RssOutcome } from './auto_grab_cadence';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const MIN = 60_000;
const ok = (agoMin: number, extra: Partial<RssOutcome> = {}): RssOutcome => ({ at: NOW - agoMin * MIN, feeds: 4, feedErrors: 0, threw: false, ...extra });
const base = { now: NOW, rssEnabled: true, rssIntervalMinutes: 15, configuredMinutes: 15 };

test('healthy rss relaxes auto-grab to 60 min', () => {
  expect(isRssHealthy({ ...base, rss: ok(5) })).toBe(true);
  expect(autoGrabIntervalMinutes({ ...base, rss: ok(5) })).toBe(60);
});

test('falls back to 15 when rss is disabled, stale, failing, empty or never ran', () => {
  expect(autoGrabIntervalMinutes({ ...base, rss: null })).toBe(15);
  expect(autoGrabIntervalMinutes({ ...base, rssEnabled: false, rss: ok(5) })).toBe(15);
  expect(autoGrabIntervalMinutes({ ...base, rss: ok(40) })).toBe(15); // > 2x15+5
  expect(autoGrabIntervalMinutes({ ...base, rss: ok(5, { feedErrors: 1 }) })).toBe(15);
  expect(autoGrabIntervalMinutes({ ...base, rss: ok(5, { feeds: 0 }) })).toBe(15);
  expect(autoGrabIntervalMinutes({ ...base, rss: ok(5, { threw: true }) })).toBe(15);
});

test('a user interval longer than 60 is left alone', () => {
  expect(autoGrabIntervalMinutes({ ...base, configuredMinutes: 120, rss: ok(5) })).toBe(120);
});

test('skips ticks inside the relaxed window, runs once due', () => {
  const rss = ok(5);
  expect(shouldRunAutoGrab({ ...base, rss, lastRunAt: NOW - 15 * MIN }).run).toBe(false);
  expect(shouldRunAutoGrab({ ...base, rss, lastRunAt: NOW - 45 * MIN }).run).toBe(false);
  // 1 min grace so a 15-min tick lands on the hour instead of slipping to 75
  expect(shouldRunAutoGrab({ ...base, rss, lastRunAt: NOW - 59.5 * MIN }).run).toBe(true);
  expect(shouldRunAutoGrab({ ...base, rss, lastRunAt: NOW - 61 * MIN }).run).toBe(true);
});

test('always runs on first boot, manual trigger, or when rss is unhealthy', () => {
  expect(shouldRunAutoGrab({ ...base, rss: ok(5), lastRunAt: null }).run).toBe(true);
  expect(shouldRunAutoGrab({ ...base, rss: ok(5), lastRunAt: NOW - MIN, manual: true }).run).toBe(true);
  expect(shouldRunAutoGrab({ ...base, rss: ok(5, { feedErrors: 2 }), lastRunAt: NOW - MIN }).run).toBe(true);
});
