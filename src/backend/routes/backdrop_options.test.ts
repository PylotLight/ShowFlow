import { test, expect } from 'bun:test';
import { dedupeBackdropOptions, clampBackdropIndex } from './images';

test('dedupeBackdropOptions drops dupes/empties and assigns stable indexes', () => {
  const out = dedupeBackdropOptions([
    { url: 'https://x/a.jpg', width: 1280, height: 720 },
    { url: 'https://x/a.jpg' },
    { url: '' },
    { url: null },
    {},
    { url: 'https://x/b.jpg' },
  ]);
  expect(out).toEqual([
    { index: 0, url: 'https://x/a.jpg', width: 1280, height: 720 },
    { index: 1, url: 'https://x/b.jpg', width: undefined, height: undefined },
  ]);
});

test('clampBackdropIndex keeps stored picks in range', () => {
  const opts = dedupeBackdropOptions([{ url: 'a' }, { url: 'b' }, { url: 'c' }]);
  expect(clampBackdropIndex(opts, 1)).toBe(1);
  expect(clampBackdropIndex(opts, 0)).toBe(0);
  expect(clampBackdropIndex(opts, 99)).toBe(2);
  expect(clampBackdropIndex(opts, -1)).toBe(0);
  expect(clampBackdropIndex(opts, NaN)).toBe(0);
  expect(clampBackdropIndex([], 0)).toBe(0);
});
