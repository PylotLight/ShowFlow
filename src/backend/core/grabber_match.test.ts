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

test('TVDB year suffix does not sink year-suffixed shows', () => {
  // "Dark Matter (2024)": the parenthesized year is metadata, not title —
  // releases carry the bare year or none at all.
  expect(isRelevantMatch(
    'Dark.Matter.2024.S02E02.Un.mondo.perfetto.ITA.ENG.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H-265-MeM.GP.mkv',
    'Dark Matter (2024)', 2, 2)).toBe(true);
  expect(isRelevantMatch('Dark.Matter.S02E02.1080p', 'Dark Matter (2024)', 2, 2)).toBe(true);
  expect(isRelevantMatch('Dark.Matter.S02E03.1080p', 'Dark Matter (2024)', 2, 2)).toBe(false);
  // Remake protection: a conflicting year still rejects.
  expect(isRelevantMatch('Dark.Matter.2016.S02E02.1080p', 'Dark Matter (2024)', 2, 2)).toBe(false);
  expect(isRelevantMatch('Dark.Matter.2016.S02E02.1080p', 'Dark Matter', 2, 2)).toBe(true);
  // Season scope behaves the same.
  expect(isRelevantMatch('Dark.Matter.2024.S02.2160p', 'Dark Matter (2024)', 2)).toBe(true);
});

test('stored show year separates same-titled shows without a title suffix', () => {
  // The original "Scrubs" row has year 2001 but no "(2001)" in its title.
  // Without the stored year a 2026 revival release looks like a match.
  expect(isRelevantMatch(
    'Scrubs (2026) S02E04 - My Chief - 2160p HDR Ai Upscale -Mesc',
    'Scrubs', 2, 4, { showYear: 2001 })).toBe(false);
  expect(isRelevantMatch(
    'Scrubs (2026) S02E04 - My Chief - 2160p HDR Ai Upscale -Mesc',
    'Scrubs (2026)', 2, 4, { showYear: 2026 })).toBe(true);
  // No year in the release still matches either show.
  expect(isRelevantMatch('Scrubs S02E04 1080p', 'Scrubs', 2, 4, { showYear: 2001 })).toBe(true);
});

test('punctuation in the show title does not sink matches', () => {
  // "Dexter: Resurrection" used to split into "dexter:" + "resurrection",
  // and "dexter:" never appears in a dotted release name, so every
  // per-episode search, RSS match and auto grab came back empty.
  expect(isRelevantMatch('Dexter.Resurrection.S02E01.2160p.ATVP.WEB-DL.DV.HDR10+.DDP5.1.Atmos.H265.MP4-BTM', 'Dexter: Resurrection', 2, 1)).toBe(true);
  expect(isRelevantMatch('Dexter Resurrection (2025) S02E01 720p hevc x265 [WD-13].mkv', 'Dexter: Resurrection', 2, 1)).toBe(true);
  expect(isRelevantMatch('Dexter.Resurrection.S02.2160p', 'Dexter: Resurrection', 2)).toBe(true);
  expect(isRelevantMatch('Dexter.Resurrection.S02E02.2160p', 'Dexter: Resurrection', 2, 1)).toBe(false);
  expect(isRelevantMatch("Greys.Anatomy.S21E01.1080p", "Grey's Anatomy", 21, 1)).toBe(true);
  expect(isRelevantMatch('Marvels.Agents.of.S.H.I.E.L.D.S07E01.1080p', "Marvel's Agents of S.H.I.E.L.D.", 7, 1)).toBe(true);
  expect(isRelevantMatch('Law.and.Order.S24E01.1080p', 'Law & Order', 24, 1)).toBe(true);
  expect(isRelevantMatch('Whats.Up.Doc.S01E01.1080p', 'What\u2019s Up, Doc?', 1, 1)).toBe(true);
  expect(isRelevantMatch('Some.Other.Show.S02E01.1080p', 'Dexter: Resurrection', 2, 1)).toBe(false);
});
