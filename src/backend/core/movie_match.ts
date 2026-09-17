import path from 'node:path';
import { db } from '../db';
import { normalizeShowTitle } from '../db/shows';

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'it', 'its']);

/**
 * Release-group/source tokens that are never part of a film title
 * (mirrors the parser's noise list plus container/audio tags that leak
 * into dot-separated movie filenames).
 */
const MOVIE_NOISE = /\b(?:2160p|1080p|720p|576p|480p|4320p|4k|uhd|web[ ._-]?dl|webrip|blu[ ._-]?ray|bluray|bdrip|brrip|hdtv|dvdrip|dvdscr|screener|hdcam|cam|telecine|x264|x265|h[ ._-]?264|h[ ._-]?265|hevc|av1|10bit|8bit|hdr(?:10)?|dolby[ ._-]?vision|dv|atmos|truehd|dts(?:[ ._-]?hd(?:[ ._-]?ma)?)?|eac3|ac3|aac\d*|flac|opus|mp3|multi(?:[ ._-]?(?:subs?|audio|lang))?|dual[ ._-]?audio|subbed|dubbed|repack|proper|remux|extended|unrated|directors[ ._-]?cut|imax|3d|sbs|hsbs|limited|internal|nogrp|rarbg|yts|yify|etrg|ion10|psa|evo|fgt|galaxyrg|tgx|mkv|mp4|avi)\b/gi;

export interface ParsedMovie {
  title: string;
  year: number | null;
}

/**
 * Splits a movie filename into a probable title + year. Returns null when
 * there is nothing title-like left (pure tags/numbers).
 *
 * Convention-first: in a scene release the title sits BEFORE the (19|20)YY
 * year and everything after it is quality/audio/group noise ("2160p", "DV",
 * "TrueHD.7.1", "GROUP"). So when a year is present we take the leading
 * segment as the title instead of trying to scrub the whole name — scrubbing
 * leaks unknown tags (an "Ai-Enhanced" / "RIFE" upscaled rip) into the title
 * and the lookup misses. No year → fall back to scrubbing the whole name.
 */
export function parseMovieFilename(filename: string): ParsedMovie | null {
  const base = path.basename(filename).replace(/\.[a-z0-9]{2,4}$/i, '');
  const spaced = base.replace(/[._]+/g, ' ');
  const ym = /\b(19\d{2}|20\d{2})\b/.exec(spaced);
  if (ym) {
    const year = parseInt(ym[1]!, 10);
    // Everything before the year is the title; drop any opening bracket the
    // year-cut landed inside ("Dune (2021)" → lead "Dune (") and trailing
    // separators, then normalize whitespace.
    const lead = spaced
      .slice(0, ym.index)
      .replace(/[\[\(\{<].*$/, '')
      .replace(/[._\-\s]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (lead.length >= 2) return { title: lead, year };
    // Year glued to the front ("2012.mkv") — no title before it.
    const tail = spaced
      .slice(ym.index + ym[0].length)
      .replace(MOVIE_NOISE, ' ')
      .replace(/[\[\](){}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (tail.length < 2) return null;
    return { title: tail.replace(/\s+[A-Z0-9]{2,8}$/, '').trim(), year };
  }
  let s = spaced.replace(/-/g, ' ').replace(MOVIE_NOISE, ' ').replace(/[\[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+[A-Z0-9]{2,8}$/, '').trim();
  if (s.length < 2) return null;
  return { title: s, year: null };
}

export interface MovieShowHit {
  showId: string;
  showTitle: string;
  showYear: number | null;
}

/**
 * Matches a title (+ optional year) against library *movie* shows via the
 * normalized show_titles index. Year gates when both sides know it
 * (remake protection: "Dune (1984)" must not match "Dune (2021)"); a
 * missing year on either side falls back to title-only.
 */
export function findMovieShow(title: string, year?: number | null): MovieShowHit | null {
  const normalized = normalizeShowTitle(title);
  if (!normalized) return null;
  let hits: any[];
  try {
    hits = db.findShowsByNormalizedTitle(normalized) ?? [];
  } catch {
    return null;
  }
  const movies = hits.filter((h: any) => h.showSeriesType === 'movie');
  if (movies.length === 0) return null;
  if (year != null) {
    const yearHit = movies.find((h: any) => h.showYear == null || h.showYear === year);
    if (yearHit) return { showId: yearHit.showId, showTitle: yearHit.showTitle, showYear: yearHit.showYear ?? null };
    return null;
  }
  const first = movies[0];
  return { showId: first.showId, showTitle: first.showTitle, showYear: first.showYear ?? null };
}

/**
 * Release-title relevance for films: significant title words must cover
 * the movie title (same 75% rule as episodes) and a conflicting year
 * rejects (remake protection). No S/E identifier exists for movies.
 */
export function isRelevantMovieMatch(releaseTitle: string, movieTitle: string, year?: number | null): boolean {
  const norm = releaseTitle.toLowerCase().replace(/[._\s-]+/g, ' ');
  const showNorm = movieTitle.toLowerCase().replace(/[._\s-]+/g, ' ');
  const words = showNorm.split(/\s+/).filter(w => !STOPWORDS.has(w) && w.length > 1);
  if (words.length === 0) return false;
  const matched = words.filter(w => norm.includes(w)).length;
  if (matched < Math.max(1, Math.ceil(words.length * 0.75))) return false;
  if (year != null) {
    const releaseYears = new Set<string>();
    for (const m of norm.matchAll(/\b(19\d{2}|20\d{2})\b/g)) releaseYears.add(m[1]!);
    if (releaseYears.size > 0 && !releaseYears.has(String(year))) return false;
  }
  return true;
}
