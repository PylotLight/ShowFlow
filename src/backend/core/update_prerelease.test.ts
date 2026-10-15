import { test, expect, describe } from 'bun:test';
import { compareSemver, isPrereleaseTag, latestStableEntry, decideAutoActivate } from './update_policy';
import { compareVersions as supervisorCompare } from '../../../supervisor/state';

describe('semver precedence', () => {
  test('a prerelease sorts below its release', () => {
    expect(compareSemver('0.1.80-test.1', '0.1.80')!).toBeLessThan(0);
    expect(compareSemver('v0.1.80', 'v0.1.80-test.1')!).toBeGreaterThan(0);
    expect(compareSemver('v0.1.80-rc.1', 'v0.1.79')!).toBeGreaterThan(0);
  });

  test('spec ordering of prerelease identifiers', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareSemver(order[i]!, order[i + 1]!)!).toBeLessThan(0);
      expect(compareSemver(order[i + 1]!, order[i]!)!).toBeGreaterThan(0);
    }
  });

  test('numeric core, v prefix, build metadata ignored', () => {
    expect(compareSemver('v0.1.10', '0.1.9')!).toBeGreaterThan(0);
    expect(compareSemver('v1.2.3+abc', '1.2.3')).toBe(0);
    expect(compareSemver('development', '0.1.80')).toBeNull();
  });

  test('supervisor copy agrees', () => {
    expect(supervisorCompare('0.1.80-test.1', '0.1.80')).toBeLessThan(0);
    expect(supervisorCompare('v0.1.80', 'v0.1.80-rc.2')).toBeGreaterThan(0);
    expect(supervisorCompare('v0.1.81', 'v0.1.80')).toBeGreaterThan(0);
    expect(supervisorCompare('development', 'v0.1.80')).toBe(0);
  });
});

describe('prerelease detection', () => {
  test('tags with a semver suffix are prereleases', () => {
    expect(isPrereleaseTag('v0.1.80-test.1')).toBe(true);
    expect(isPrereleaseTag('v0.0.0-citest.1')).toBe(true);
    expect(isPrereleaseTag('v1.0.0-rc1')).toBe(true);
    expect(isPrereleaseTag('v0.1.80')).toBe(false);
    expect(isPrereleaseTag('v0.1.80+build.5')).toBe(false);
    expect(isPrereleaseTag('development')).toBe(false);
  });

  test('watcher picks the newest stable feed entry', () => {
    const feed = [{ tag: 'v0.1.82-test.1' }, { tag: 'v0.1.81-rc.2' }, { tag: 'v0.1.81' }, { tag: 'v0.1.80' }];
    expect(latestStableEntry(feed)?.tag).toBe('v0.1.81');
    expect(latestStableEntry([{ tag: 'v0.1.82-test.1' }])).toBeUndefined();
  });

  test('auto-activate never fires for a prerelease', () => {
    const base = { settings: { mode: 'idle' as const, hour: 4 }, now: new Date(), failedReleaseId: null, busy: [], activating: false };
    const pre = decideAutoActivate({ ...base, pending: { releaseId: 'abc', tag: 'v0.1.81-test.1' } });
    expect(pre.activate).toBe(false);
    expect(pre.reason).toContain('prerelease');
    expect(decideAutoActivate({ ...base, pending: { releaseId: 'abc', tag: 'v0.1.81' } }).activate).toBe(true);
  });
});
