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

test('isRelevantMovieMatch gates on title words + conflicting year', () => {
  expect(isRelevantMovieMatch('Dune.Part.Two.2024.1080p.BluRay', 'Dune Part Two', 2024)).toBe(true);
  // Remake protection: wrong year rejects.
  expect(isRelevantMovieMatch('Dune.1984.1080p.BluRay', 'Dune', 2021)).toBe(false);
  // Release without a year still matches on title.
  expect(isRelevantMovieMatch('Dune.Part.Two.BluRay.REMUX', 'Dune Part Two', 2024)).toBe(true);
  // Wrong film rejects.
  expect(isRelevantMovieMatch('Dune.Part.Two.2024.1080p', 'Oppenheimer', 2023)).toBe(false);
});
