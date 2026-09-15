import { test, expect } from 'bun:test';
import { isRelevantMatch } from './grabber_service';

// Season scope must not leak other seasons' episodes (a season Browse
// reading as a full-series search).
test('season scope keeps own-season releases only', () => {
  expect(isRelevantMatch('Reacher S03E04 1080p', 'Reacher', 3)).toBe(true);
  expect(isRelevantMatch('Reacher S03 1080p Complete', 'Reacher', 3)).toBe(true);
  expect(isRelevantMatch('Reacher Season 3 Complete 2160p', 'Reacher', 3)).toBe(true);
  expect(isRelevantMatch('Reacher 3x04 HDTV', 'Reacher', 3)).toBe(true);
  expect(isRelevantMatch('Reacher S3 720p', 'Reacher', 3)).toBe(true);
  expect(isRelevantMatch('Reacher S01E01 1080p', 'Reacher', 3)).toBe(false);
  expect(isRelevantMatch('Reacher S04E02 1080p', 'Reacher', 3)).toBe(false);
  expect(isRelevantMatch('Reacher S10E01 1080p', 'Reacher', 3)).toBe(false);
  expect(isRelevantMatch('Reacher S1 1080p', 'Reacher', 3)).toBe(false);
  expect(isRelevantMatch('Some Other Show S03E04 1080p', 'Reacher', 3)).toBe(false);
});

test('specials scope matches S00 / Season 0 / special markers only', () => {
  expect(isRelevantMatch('Reacher S00E02 1080p', 'Reacher', 0)).toBe(true);
  expect(isRelevantMatch('Reacher Season 0 Extras', 'Reacher', 0)).toBe(true);
  expect(isRelevantMatch('Reacher Behind the Scenes Special 1080p', 'Reacher', 0)).toBe(true);
  expect(isRelevantMatch('Reacher S03E04 1080p', 'Reacher', 0)).toBe(false);
});

test('absolute-numbered series keep title-only matching', () => {
  expect(isRelevantMatch('Dandadan 012 1080p', 'Dandadan', 1, undefined, { absolute: true })).toBe(true);
  expect(isRelevantMatch('Dandadan 012 1080p', 'Dandadan', 1)).toBe(false);
});

test('episode scope behavior is unchanged', () => {
  expect(isRelevantMatch('Reacher S03E04 1080p', 'Reacher', 3, 4)).toBe(true);
  expect(isRelevantMatch('Reacher S03E05 1080p', 'Reacher', 3, 4)).toBe(false);
});
