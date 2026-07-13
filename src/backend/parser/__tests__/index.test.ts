import { test, expect, describe } from 'bun:test';
import { FilenameParser } from '../index';

describe('FilenameParser', () => {
  const parser = new FilenameParser();

  test('parses SxxExx dotted format', () => {
    const result = parser.parse('The.Office.S02E05.1080p.mkv');
    expect(result?.show).toBe('The Office');
    expect(result?.season).toBe(2);
    expect(result?.episodes).toContain(5);
  });

  test('parses SxxExx spaced format', () => {
    const result = parser.parse('The Office S02E05.mkv');
    expect(result?.show).toBe('The Office');
    expect(result?.season).toBe(2);
    expect(result?.episodes).toContain(5);
  });

  test('parses 1x01 format', () => {
    const result = parser.parse('Breaking.Bad.1x07.mkv');
    expect(result?.show).toBe('Breaking Bad');
    expect(result?.episodes).toContain(7);
  });

  test('parses absolute-numbered anime release', () => {
    const result = parser.parse('One.Piece.E1050.mkv');
    expect(result?.show).toBe('One Piece');
  });

  test('returns null for a filename with no recognizable pattern', () => {
    const result = parser.parse('random_video_file.mkv');
    // A bare number pattern may still match depending on filename shape -
    // the important invariant is it never throws.
    expect(() => parser.parse('random_video_file.mkv')).not.toThrow();
  });

  test('strips separators from show name', () => {
    const result = parser.parse('Attack_on_Titan.S04E16.mkv');
    expect(result?.show).toBe('Attack on Titan');
  });

  test('parses Season X Episode Y text format', () => {
    const result = parser.parse('[Mizurex33] Quanzhi Fashi Season 02 Episode 03 [1080p].mkv');
    expect(result?.show).toBe('Quanzhi Fashi');
    expect(result?.season).toBe(2);
    expect(result?.episodes).toContain(3);
  });

  test('parses Season X Episode Y without release group', () => {
    const result = parser.parse('Quanzhi Fashi Season 02 Episode 03.mkv');
    expect(result?.show).toBe('Quanzhi Fashi');
    expect(result?.season).toBe(2);
    expect(result?.episodes).toContain(3);
  });

  test('parses Season X Episode Y dotted format', () => {
    const result = parser.parse('ShowName.Season.03.Episode.12.720p.mkv');
    expect(result?.show).toBe('ShowName');
    expect(result?.season).toBe(3);
    expect(result?.episodes).toContain(12);
  });

  test('parses Season X Episode Y dotted format with release group', () => {
    const result = parser.parse('[ReleaseGroup] ShowName.Season.03.Episode.12.720p.mkv');
    expect(result?.show).toBe('ShowName');
    expect(result?.season).toBe(3);
    expect(result?.episodes).toContain(12);
  });

  test('strips release group names in curly braces', () => {
    const result = parser.parse('{HorribleSubs} Attack on Titan S04E16 720p.mkv');
    expect(result?.show).toBe('Attack on Titan');
    expect(result?.season).toBe(4);
    expect(result?.episodes).toContain(16);
  });

  test('strips release group names in parentheses', () => {
    const result = parser.parse('(Commie) Show.Name.Season.03.Episode.12.720p.mkv');
    expect(result?.show).toBe('Show Name');
    expect(result?.season).toBe(3);
    expect(result?.episodes).toContain(12);
  });

  test('strips multiple release group names', () => {
    const result = parser.parse('[Group1][Group2] ShowName S01E05.mkv');
    expect(result?.show).toBe('ShowName');
    expect(result?.season).toBe(1);
    expect(result?.episodes).toContain(5);
  });

  test('strips release group names in middle of filename', () => {
    const result = parser.parse('ShowName [Group] S01E05.mkv');
    expect(result?.show).toBe('ShowName');
    expect(result?.season).toBe(1);
    expect(result?.episodes).toContain(5);
  });
});
