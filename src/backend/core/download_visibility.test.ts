import { test, expect } from 'bun:test';
import { parseInflight, formatBytesShort, formatFetchDetail, RETRYABLE_STATUS, MAX_FILE_ATTEMPTS } from './download_clients/torbox';
import { BackgroundJobRegistry } from './background_jobs';
import { resolveShowScanDir } from './library_scanner';

test('parseInflight accepts valid lists and rejects garbage', () => {
  expect(parseInflight(null)).toEqual([]);
  expect(parseInflight('not json')).toEqual([]);
  expect(parseInflight('{}')).toEqual([]);
  expect(parseInflight([{ torrentId: '1', title: 'A' }])).toEqual([{ torrentId: '1', title: 'A' }]);
  expect(parseInflight(JSON.stringify([{ torrentId: '1', title: 'A' }, { nope: true }, null]))).toEqual([
    { torrentId: '1', title: 'A' },
  ]);
});

test('formatBytesShort scales units', () => {
  expect(formatBytesShort(0)).toBe('0 B');
  expect(formatBytesShort(512)).toBe('512.0 B');
  expect(formatBytesShort(8.5 * 1024 * 1024)).toBe('8.5 MiB');
  expect(formatBytesShort(6.2 * 1024 ** 3)).toBe('6.2 GiB');
});

test('formatFetchDetail shows file position, percent, amounts and speed', () => {
  const d = formatFetchDetail(2, 3, 35 * 1024 ** 2, 100 * 1024 ** 2, 8.5 * 1024 ** 2);
  expect(d).toContain('Fetching file 2/3');
  expect(d).toContain('35%');
  expect(d).toContain('MiB');
  expect(d).toContain('/s');
  const unknown = formatFetchDetail(1, 1, 1024, 0, 0);
  expect(unknown).toContain('Fetching file 1/1');
  expect(unknown).not.toContain('%');
});

test('finished jobs are retained and capped, running jobs exempt', () => {
  const registry = new BackgroundJobRegistry();
  for (let i = 0; i < 210; i++) {
    registry.register({ id: `job-${i}`, type: 'test', label: `Job ${i}` });
    registry.complete(`job-${i}`, 'done');
  }
  registry.register({ id: 'live', type: 'test', label: 'Live' });
  const all = registry.list();
  expect(all.some(j => j.id === 'live' && j.status === 'running')).toBe(true);
  expect(all.filter(j => j.status !== 'running').length).toBeLessThanOrEqual(200);
  // Oldest finished evicted first: job-0..job-9 gone, job-209 kept.
  expect(all.some(j => j.id === 'job-0')).toBe(false);
  expect(all.some(j => j.id === 'job-209')).toBe(true);
});

test('resolveShowScanDir prefers the owned folder, falls back to sanitized title', () => {
  const root = '/Data/Media/Shows';
  expect(
    resolveShowScanDir(root, 'Reacher', [
      `${root}/Reacher/Season 4/Reacher - S04E01.mkv`,
      `${root}/Reacher/Season 3/Reacher - S03E01.mkv`,
    ]),
  ).toBe(`${root}/Reacher`);
  // No files yet -> sanitized title folder.
  expect(resolveShowScanDir(root, 'Reacher', [])).toBe(`${root}/Reacher`);
  expect(resolveShowScanDir(root, 'Re: Zero', [null, undefined, ''])).toBe(`${root}/Re Zero`);
  // Files outside the root are ignored.
  expect(resolveShowScanDir(root, 'Reacher', ['/other/place/Reacher/x.mkv'])).toBe(`${root}/Reacher`);
});

test('transient CDN failures are retryable, client errors are not', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]) {
    expect(RETRYABLE_STATUS.has(s)).toBe(true);
  }
  for (const s of [400, 401, 403, 404, 410, 416]) {
    expect(RETRYABLE_STATUS.has(s)).toBe(false);
  }
  expect(MAX_FILE_ATTEMPTS).toBeGreaterThan(1);
});
