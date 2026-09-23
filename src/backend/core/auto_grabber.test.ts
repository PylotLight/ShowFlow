import { test, expect } from 'bun:test';
import { isDueForSearch } from './auto_grabber';

const HOUR = 3_600_000;

test('stale past forecast cannot make a future episode due', () => {
  const now = Date.now();
  const futureAir = new Date(now + 3 * 24 * HOUR).toISOString();
  const stalePastExpected = new Date(now - 2 * HOUR).toISOString();
  // The reported bug: air_date Sat Sep 26 but a stale expected_release_at
  // in the past kept the episode "due" (and "awaiting release").
  expect(isDueForSearch({
    air_date: futureAir,
    air_time: null,
    expected_release_at: stalePastExpected,
    release_delay_minutes: null,
  }, now)).toBe(false);
});

test('aired episode with no forecast yet is due', () => {
  const now = Date.now();
  const pastAir = new Date(now - 2 * HOUR).toISOString();
  expect(isDueForSearch({
    air_date: pastAir,
    air_time: null,
    expected_release_at: null,
    release_delay_minutes: null,
  }, now)).toBe(true);
});

test('future episode with no forecast is not due', () => {
  const now = Date.now();
  const futureAir = new Date(now + 2 * HOUR).toISOString();
  expect(isDueForSearch({
    air_date: futureAir,
    air_time: null,
    expected_release_at: null,
    release_delay_minutes: null,
  }, now)).toBe(false);
});

test('dateless episode trusts the stored forecast', () => {
  const now = Date.now();
  expect(isDueForSearch({
    air_date: null,
    air_time: null,
    expected_release_at: new Date(now - HOUR).toISOString(),
    release_delay_minutes: null,
  }, now)).toBe(true);
  expect(isDueForSearch({
    air_date: null,
    air_time: null,
    expected_release_at: null,
    release_delay_minutes: null,
  }, now)).toBe(false);
});
