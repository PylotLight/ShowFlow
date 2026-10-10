/**
 * Sample-file detection.
 *
 * Scene/P2P releases routinely ship a short "sample" clip next to the real
 * video (`Sample/show.s01e01.sample.mkv`, `show.s01e01-sample.mkv`,
 * `sample-grp-show.mkv`, …). It carries the SAME release tags as the main
 * file, so it parses to the same episode and scores the same (or higher,
 * against a probed library file) in the quality engine — which meant a
 * multi-file torrent could import the episode and then "upgrade" it to the
 * 50 MB sample a moment later. Samples must never reach import.
 */

/** Matches `sample` / `samples` as its own token (not inside a word). */
const SAMPLE_TOKEN = /(^|[\s._\-\[\(])samples?($|[\s._\-\]\)])/i;

/**
 * True when a file path or name looks like a release sample.
 * Checks folder segments (`Sample/`, `Samples/`) and the basename token.
 */
export function isSampleFile(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1]!;
  // Any parent folder named sample(s).
  for (const seg of segments.slice(0, -1)) {
    if (/^samples?$/i.test(seg)) return true;
  }
  const stem = base.replace(/\.[^.]+$/, '');
  return SAMPLE_TOKEN.test(stem);
}

/**
 * A video this much smaller than the biggest video in the same torrent is
 * treated as a sample/extra (only applied when the torrent has 2+ videos).
 * Season packs have similarly sized episodes, so they are unaffected.
 */
export const SAMPLE_SIZE_RATIO = 0.1;

/**
 * From a torrent's video files, drop samples: anything named like a sample,
 * plus (for multi-video torrents) anything under SAMPLE_SIZE_RATIO of the
 * largest remaining file. The size rule can never drop the largest file, so
 * only a torrent whose every video is NAMED a sample comes back empty.
 */
export function filterOutSamples<T extends { name?: string; short_name?: string; size?: number }>(files: T[]): T[] {
  const named = files.filter(f => !isSampleFile(f.name || '') && !isSampleFile(f.short_name || ''));
  if (named.length < 2) return named;
  const sizeOf = (f: T) => (typeof f.size === 'number' ? f.size : 0);
  const largest = Math.max(...named.map(sizeOf));
  if (largest <= 0) return named;
  return named.filter(f => {
    const size = sizeOf(f);
    return size <= 0 || size >= largest * SAMPLE_SIZE_RATIO;
  });
}
