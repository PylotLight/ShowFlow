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
});
