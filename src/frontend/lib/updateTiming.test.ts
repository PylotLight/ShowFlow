import { test, expect } from 'bun:test';
import { reconnectDelayMs, pendingPollMs, lastApplySeconds, applyEstimateLabel } from './updateTiming';

test('reconnect delay starts at 500ms and caps at 2s', () => {
  const mid = () => 0.5;
  expect(reconnectDelayMs(0, mid)).toBe(500);
  expect(reconnectDelayMs(1, mid)).toBe(625);
  expect(reconnectDelayMs(10, mid)).toBe(2000);
  expect(reconnectDelayMs(50, () => 1)).toBe(2200);
  expect(reconnectDelayMs(0, () => 0)).toBe(450);
  // first 8 polls: ~9.5s of coverage (old 800ms×1.4→4s curve: ~20.8s), so a
  // build that's up at 6s is noticed within ~1.5s instead of up to 4s
  const total = Array.from({ length: 8 }, (_, i) => reconnectDelayMs(i, mid)).reduce((a, b) => a + b, 0);
  expect(total).toBeLessThan(10_000);
});

test('pending poll is fast only while awaiting a handoff', () => {
  expect(pendingPollMs(true)).toBe(500);
  expect(pendingPollMs(false)).toBe(1500);
});

test('lastApplySeconds only trusts successful, sane samples', () => {
  expect(lastApplySeconds({ outcome: 'activated', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T00:00:07.4Z' })).toBe(7);
  expect(lastApplySeconds({ outcome: 'rolled-back', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T00:00:07Z' })).toBeNull();
  expect(lastApplySeconds({ outcome: 'activated', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T01:00:00Z' })).toBeNull();
  expect(lastApplySeconds(null)).toBeNull();
});

test('estimate label', () => {
  expect(applyEstimateLabel({ outcome: 'activated', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T00:00:05Z' }, false)).toBe('Applying takes ~5s (last update)');
  expect(applyEstimateLabel(null, true)).toBe('Applying usually takes a few seconds, plus a quick database backup');
});
