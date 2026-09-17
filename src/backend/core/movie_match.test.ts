import { test, expect } from 'bun:test';
import { parseMovieFilename, isRelevantMovieMatch } from './movie_match';

test('parseMovieFilename splits title + year, strips tags', () => {
  expect(parseMovieFilename('Dune.Part.Two.2024.1080p.BluRay.x264-GROUP.mkv'))
    .toEqual({ title: 'Dune Part Two', year: 2024 });
  expect(parseMovieFilename('The.Matrix.1999.REMUX.2160p.HDR.HEVC.TrueHD.Atmos.mkv'))
    .toEqual({ title: 'The Matrix', year: 1999 });
  expect(parseMovieFilename('Dune (2021) [IMAX].mp4'))
    .toEqual({ title: 'Dune', year: 2021 });
});

test('parseMovieFilename returns null for tag soup', () => {
  expect(parseMovieFilename('1080p.x264.mkv')).toBeNull();
});

test('parseMovieFilename cuts the title at the year (tags never leak in)', () => {
  // A 50GB upscaled remux: every token after the year is quality/audio/group
  // noise. Tag-scrubbing alone left "Thor HDR10Plus Ai Enhanced …" behind,
  // which matched nothing in the library.
  expect(parseMovieFilename('Thor.2011.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.7.1.Atmos.MULTI-RIFE.4.25v2-60fps-DirtyHippie.mkv'))
    .toEqual({ title: 'Thor', year: 2011 });
  // Titles that contain a hyphen survive it.
  expect(parseMovieFilename('Spider-Man.2002.2160p.mkv')).toEqual({ title: 'Spider-Man', year: 2002 });
  // Number-leading titles keep their digits.
  expect(parseMovieFilename('300.2006.Extended.DVDRip.mkv')).toEqual({ title: '300', year: 2006 });
  // No year → whole-name scrub (and no invented year).
  expect(parseMovieFilename('Whiplash.mkv')).toEqual({ title: 'Whiplash', year: null });
});

test('isRelevantMovieMatch gates on title words + conflicting year', () => {
  expect(isRelevantMovieMatch('Dune.Part.Two.2024.1080p.BluRay', 'Dune Part Two', 2024)).toBe(true);
  // Remake protection: wrong year rejects.
  expect(isRelevantMovieMatch('Dune.1984.1080p.BluRay', 'Dune', 2021)).toBe(false);
  // Release without a year still matches on title.
  expect(isRelevantMovieMatch('Dune.Part.Two.BluRay.REMUX', 'Dune Part Two', 2024)).toBe(true);
  // Wrong film rejects.
  expect(isRelevantMovieMatch('Dune.Part.Two.2024.1080p', 'Oppenheimer', 2023)).toBe(false);
});
