import { test, expect } from 'bun:test';
import { resolveBuildStamp } from './build_stamp';

const SHA = '6254d02ed7cae6730366256269a8cba4d4a4ec24';

test('release builds take SHOWFLOW_VERSION/SHOWFLOW_COMMIT over the runner GITHUB_* vars', () => {
  // workflow_call from a workflow_dispatch on main: GITHUB_REF_NAME is "main".
  const s = resolveBuildStamp({ SHOWFLOW_RELEASE_BUILD: '1', SHOWFLOW_VERSION: 'v0.1.82', SHOWFLOW_COMMIT: SHA, GITHUB_REF_NAME: 'main', GITHUB_SHA: '3f614199eed2d69600820558be9269bd9eeaf4dc' });
  expect(s).toEqual({ version: 'v0.1.82', commit: SHA });
});

test('a release build stamped "main" fails instead of shipping', () => {
  expect(() => resolveBuildStamp({ SHOWFLOW_RELEASE_BUILD: '1', GITHUB_REF_NAME: 'main', GITHUB_SHA: SHA })).toThrow(/isn't a semver tag/);
  expect(() => resolveBuildStamp({ SHOWFLOW_RELEASE_BUILD: '1', SHOWFLOW_VERSION: 'v0.1.82', SHOWFLOW_COMMIT: 'main' })).toThrow(/full git sha/);
  expect(resolveBuildStamp({ SHOWFLOW_RELEASE_BUILD: '1', SHOWFLOW_VERSION: 'v1.2.3-rc.1', SHOWFLOW_COMMIT: SHA }).version).toBe('v1.2.3-rc.1');
});

test('local / PR builds keep the old fallbacks', () => {
  expect(resolveBuildStamp({})).toEqual({ version: 'development', commit: 'development' });
  expect(resolveBuildStamp({ GITHUB_REF_NAME: '21/merge', GITHUB_SHA: SHA })).toEqual({ version: '21/merge', commit: SHA });
});
