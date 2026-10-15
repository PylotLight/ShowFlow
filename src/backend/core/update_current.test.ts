import { test, expect } from 'bun:test';
import { resolveCurrentVersion, releaseRelation, isReleaseVersion } from './update_policy';

test('a bad stamp ("main") falls back to the manifest / activation tag', () => {
  expect(isReleaseVersion('main')).toBe(false);
  expect(resolveCurrentVersion(['v0.1.82'])).toBe('v0.1.82');
  expect(resolveCurrentVersion(['main', 'main', 'v0.1.81'])).toBe('v0.1.81');
  expect(resolveCurrentVersion(['main', null, undefined])).toBeNull();
});

test('releaseRelation: same sha is current whatever the tag says (ETXTBSY guard)', () => {
  const cur = { version: null, releaseId: '6254d02' };
  expect(releaseRelation('v0.1.81', '6254d02', cur)).toBe('current');
  expect(releaseRelation('v0.1.82', 'abc1234', cur)).toBe('unknown');
});

test('releaseRelation: only newer releases are updates; older are previous', () => {
  const cur = { version: 'v0.1.81', releaseId: '6254d02' };
  expect(releaseRelation('v0.1.82', 'abc1234', cur)).toBe('newer');
  expect(releaseRelation('v0.1.80', 'def5678', cur)).toBe('older');
  expect(releaseRelation('v0.1.81', null, cur)).toBe('current');
  expect(releaseRelation('v0.1.81-test.1', 'x', cur)).toBe('older');
});
