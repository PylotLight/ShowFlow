import { test, expect } from 'bun:test';
import { toCardPosterUrl } from './_shared';

test('toCardPosterUrl downsizes TMDB posters to w342', () => {
  expect(toCardPosterUrl('tmdb', 'https://image.tmdb.org/t/p/w500/abc.jpg'))
    .toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
  expect(toCardPosterUrl('tmdb', 'https://image.tmdb.org/t/p/original/abc.jpg'))
    .toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
});

test('toCardPosterUrl swaps AniList large for medium', () => {
  expect(toCardPosterUrl('anilist', 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-abc.jpg'))
    .toBe('https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21-abc.jpg');
});

test('toCardPosterUrl passes TVDB through and nulls null', () => {
  const tvdb = 'https://artworks.thetvdb.com/banners/posters/123.jpg';
  expect(toCardPosterUrl('tvdb', tvdb)).toBe(tvdb);
  expect(toCardPosterUrl('tmdb', null)).toBeNull();
});
