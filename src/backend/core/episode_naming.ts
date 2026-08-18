/**
 * Episode filename formatting engine, mirroring Sonarr's Episode Naming
 * settings. A format string written in `{token}` syntax is rendered into a
 * final base filename (no extension). Tokens cover the ones Sonarr exposes
 * for Standard/Daily/Anime series plus the media-info and quality tokens the
 * naming UI surfaces (issues-tracking.md #14).
 */

export type MultiEpisodeStyle = 'extend' | 'scene' | 'office' | 'repeat';
export type ColonReplacement = 'smart' | 'space' | 'dash' | 'delete';

export interface NamingEpisode {
  season: number;
  episode: number;
  absoluteNumber?: number | null;
  title?: string | null;
  airDate?: string | null;
}

export interface NamingMedia {
  /** Display height in px (e.g. 1080, 2160). */
  height?: number | null;
  /** Video codec string from the probe (e.g. 'h264', 'hevc', 'av1'). */
  codec?: string | null;
  hdr?: boolean | null;
  /** First audio track codec (e.g. 'aac', 'eac3', 'truehd'). */
  audioCodec?: string | null;
  audioChannels?: number | null;
  container?: string | null;
}

export interface NamingConfig {
  standardEpisodeFormat?: string;
  dailyEpisodeFormat?: string;
  animeEpisodeFormat?: string;
  multiEpisodeStyle?: MultiEpisodeStyle;
  replaceIllegalCharacters?: boolean;
  colonReplacement?: ColonReplacement;
  renameEpisodes?: boolean;
}

export interface EpisodeNamingInput {
  seriesTitle: string;
  seriesType?: 'standard' | 'daily' | 'anime';
  episodes: NamingEpisode[];
  /** The release filename the file was imported from (quality/group tokens). */
  originalFilename?: string | null;
  media?: NamingMedia | null;
  config?: NamingConfig;
}

export const DEFAULT_STANDARD_FORMAT =
  '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';
export const DEFAULT_DAILY_FORMAT =
  '{Series Title} - {Air Date} - {Episode Title} {Quality Full}';
export const DEFAULT_ANIME_FORMAT =
  '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';

const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** "The 100" -> "100, The" — Sonarr's {Series TitleThe} style. */
function titleThe(value: string): string {
  const m = value.match(/^(the|a|an)\s+(.+)$/i);
  if (!m) return value;
  const article = m[1];
  const rest = m[2];
  if (article === undefined || rest === undefined || article.length === 0) return value;
  return `${rest}, ${article[0]!.toUpperCase() + article.slice(1)}`;
}

function applyColonReplacement(value: string, style: ColonReplacement): string {
  switch (style) {
    case 'space':
      return value.replace(/:/g, ' ');
    case 'dash':
      return value.replace(/:\s*/g, ' - ');
    case 'delete':
      return value.replace(/:/g, '');
    case 'smart':
    default:
      // Smart Replace: a colon followed by a digit is removed (so "Episode 1"
      // stays readable), otherwise it is replaced with a space.
      return value.replace(/:(?=\d)/g, '').replace(/:/g, ' ');
  }
}

function cleanText(value: string, config: NamingConfig): string {
  let out = value;
  if (config.colonReplacement && config.colonReplacement !== 'smart') {
    out = applyColonReplacement(out, config.colonReplacement);
  } else if (config.replaceIllegalCharacters !== false) {
    out = applyColonReplacement(out, 'smart');
  }
  if (config.replaceIllegalCharacters !== false) {
    out = out.replace(ILLEGAL_CHARS, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---- Quality derivation ------------------------------------------------

interface QualityTokens {
  source: string;
  resolution: string | null;
  proper: string;
  group: string | null;
}

const SOURCE_PATTERNS: [string, RegExp][] = [
  ['WEB-DL', /\bweb[\s._-]?dl\b/i],
  ['WEBRip', /\bweb[\s._-]?rips?\b/i],
  ['BluRay', /\bblu[\s._-]?rays?\b/i],
  ['Remux', /\bremux\b/i],
  ['HDTV', /\bhdtv\b/i],
  ['DVD', /\bdvd\b/i],
];

const RESOLUTION_PATTERNS: [string, RegExp][] = [
  ['2160p', /\b(?:2160p|4k)\b/i],
  ['1080p', /\b1080p\b/i],
  ['720p', /\b720p\b/i],
  ['576p', /\b576p\b/i],
  ['480p', /\b480p\b/i],
];

const PROPER_PATTERNS: [string, RegExp][] = [
  ['v2', /\bv[2-9]\b/i],
  ['v3', /\bv[3-9]\b/i],
  ['Proper', /\bproper\b/i],
  ['Repack', /\brepack\b/i],
];

/** Pull source/resolution/proper/release-group out of a release filename. */
export function parseQualityTokens(filename: string): QualityTokens {
  const lower = filename;
  let source = '';
  for (const [name, re] of SOURCE_PATTERNS) {
    if (re.test(lower)) {
      source = name === 'Remux' ? 'BluRay' : name;
      if (name === 'Remux') break;
    }
  }
  let resolution: string | null = null;
  for (const [res, re] of RESOLUTION_PATTERNS) {
    if (re.test(lower)) {
      resolution = res;
      break;
    }
  }
  let proper = '';
  for (const [name, re] of PROPER_PATTERNS) {
    if (re.test(lower)) {
      proper = name;
      break;
    }
  }
  let group: string | null = null;
  const base = filename.replace(/\.[^.]+$/, '');
  const bracket = base.match(/[\[(\[]([A-Z0-9][A-Z0-9 ._-]{1,20})[\])\]]\s*$/) ?? base.match(/^[\[(\[]([A-Z0-9][A-Z0-9 ._-]{1,20})[\])\]]/);
  const trailingGroup = base.match(/[-_.]([A-Za-z0-9]{2,})$/) ?? base.match(/(?:^)([A-Za-z0-9]{2,})$/);
  const groupCandidate = bracket?.[1] ?? trailingGroup?.[1];
  if (groupCandidate && !/(S\d{1,3}E\d{1,3}|1080p|2160p|720p|480p|576p|x\d{2,4}|h[.]?264|h[.]?265|hevc|hdr|web|blu|proper|repack)/i.test(groupCandidate)) {
    group = groupCandidate.replace(/[._]/g, ' ');
  }
  return { source, resolution, proper, group };
}

function resolveResolution(media: NamingMedia | null | undefined, filenameTokens: QualityTokens): string {
  if (filenameTokens.resolution) return filenameTokens.resolution;
  const h = media?.height;
  if (h && h >= 2000) return '2160p';
  if (h && h >= 1200) return '1080p';
  if (h && h >= 700) return '720p';
  if (h && h >= 500) return '576p';
  if (h) return '480p';
  return 'HD';
}

function resolveSource(media: NamingMedia | null | undefined, filenameTokens: QualityTokens): string {
  if (filenameTokens.source) return filenameTokens.source;
  if (media?.hdr) return 'BluRay';
  if (media?.codec === 'hevc') return 'WEB-DL';
  return 'WEB';
}

function codecShort(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c.includes('264') || c.includes('avc')) return 'x264';
  if (c.includes('265') || c.includes('hevc')) return 'x265';
  if (c.includes('av1')) return 'AV1';
  if (c.includes('vp9')) return 'VP9';
  return null;
}

function audioCodecLabel(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c.includes('eac3') || c.includes('ec-3') || c.includes('ec3')) return 'EAC3';
  if (c.includes('aac')) return 'AAC';
  if (c.includes('ac3')) return 'AC3';
  if (c.includes('truehd')) return 'TrueHD';
  if (c.includes('dts')) return 'DTS';
  if (c.includes('flac')) return 'FLAC';
  if (c.includes('mp3')) return 'MP3';
  if (c.includes('opus')) return 'Opus';
  return c.toUpperCase();
}

function audioChannelsLabel(channels: number | null | undefined): string | null {
  if (!channels) return null;
  const map: Record<number, string> = { 1: '1.0', 2: '2.0', 4: '4.0', 6: '5.1', 8: '7.1' };
  return map[channels] ?? `${channels}.0`;
}

/** Sonarr's `{Quality Title}` + `{Quality Proper}` (e.g. "WEBDL-1080p Proper"). */
export function qualityFull(input: { originalFilename?: string | null; media?: NamingMedia | null }): string {
  const { originalFilename, media } = input;
  const qualityTitle = qualityTitleString({ originalFilename, media });
  const proper = parseQualityTokens(originalFilename ?? '').proper;
  return proper ? `${qualityTitle} ${proper}` : qualityTitle;
}

function qualityTitleString(input: { originalFilename?: string | null; media?: NamingMedia | null }): string {
  const { originalFilename, media } = input;
  const tokens = parseQualityTokens(originalFilename ?? '');
  const source = resolveSource(media, tokens);
  const resolution = resolveResolution(media, tokens);
  return `${source}-${resolution}`;
}

/** Render the base filename (no extension) for an episode naming format. */
export function renderEpisodeName(input: EpisodeNamingInput, format: string): string {
  const {
    seriesTitle,
    episodes,
    originalFilename,
    media,
    config = {},
  } = input;

  const multiStyle = config.multiEpisodeStyle ?? 'extend';
  const first = episodes[0];
  const epNums = episodes.map(e => e.episode);

  const seasonValue = first?.season ?? 1;
  const episodeString =
    epNums.length > 1
      ? multiEpisodeString(epNums, multiStyle)
      : String(epNums[0] ?? 1).padStart(2, '0');

  const airDate = first?.airDate ? String(first.airDate).slice(0, 10) : '';

  const tokens = parseQualityTokens(originalFilename ?? '');
  const source = resolveSource(media, tokens);
  const resolution = resolveResolution(media, tokens);
  const qualityTitle = `${source}-${resolution}`;
  const proper = tokens.proper;
  const group = tokens.group;
  const codec = codecShort(media?.codec);
  const audioCodec = audioCodecLabel(media?.audioCodec);
  const audioCh = audioChannelsLabel(media?.audioChannels);
  const absolute = first?.absoluteNumber;

  const replacements: Record<string, string> = {
    '{Series Title}': seriesTitle,
    '{Series Clean Title}': cleanText(seriesTitle, config),
    '{Series TitleThe}': titleThe(seriesTitle),
    '{Episode Title}': first?.title ?? '',
    '{Episode Clean Title}': cleanText(first?.title ?? '', config),
    '{season}': String(seasonValue),
    '{season:00}': pad(seasonValue, 2),
    '{season:0}': pad(seasonValue, 2),
    '{episode}': epNums.length > 1 ? episodeString : String(epNums[0] ?? 1),
    '{episode:00}': episodeString,
    '{episode:0}': episodeString,
    '{Absolute Episode Number}': absolute != null ? String(absolute) : String(epNums[0] ?? 1),
    '{Absolute Episode Number:00}': absolute != null ? pad(absolute, 2) : pad(epNums[0] ?? 1, 2),
    '{Air Date}': airDate,
    '{Quality Title}': qualityTitle,
    '{Quality Full}': proper ? `${qualityTitle} ${proper}` : qualityTitle,
    '{Quality Proper}': proper,
    '{MediaInfo Video}': codec ?? '',
    '{MediaInfo Simple}': codec ?? '',
    '{MediaInfo VideoCodec}': codec ?? (media?.codec ? String(media.codec).toUpperCase() : ''),
    '{MediaInfo Full}': [codec, resolution].filter(Boolean).join(' '),
    '{MediaInfo AudioCodec}': audioCodec ?? '',
    '{MediaInfo AudioChannels}': audioCh ?? '',
    '{Release Group}': group ?? '',
    '{Original Filename}': originalFilename ?? '',
    '{Original Title}': originalFilename?.replace(/\.[^.]+$/, '') ?? '',
  };

  let out = format;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }

  return cleanText(out, config);
}

/** Multi-episode suffix per Sonarr's Multi Episode Style setting. */
function multiEpisodeString(epNums: number[], style: MultiEpisodeStyle): string {
  const first = epNums[0] ?? 1;
  const last = epNums[epNums.length - 1] ?? first;
  switch (style) {
    case 'office':
      return `${pad(first, 2)}-${pad(last, 2)}`;
    case 'repeat':
      return epNums.map(n => pad(n, 2)).join('-E');
    case 'scene':
    case 'extend':
    default:
      return epNums.map(n => pad(n, 2)).join('-');
  }
}

/** Pick the format string for a series type, falling back to Sonarr defaults. */
export function formatForSeriesType(
  seriesType: string | undefined,
  config: NamingConfig,
): string {
  if (seriesType === 'daily') {
    return config.dailyEpisodeFormat || DEFAULT_DAILY_FORMAT;
  }
  if (seriesType === 'anime') {
    return config.animeEpisodeFormat || DEFAULT_ANIME_FORMAT;
  }
  return config.standardEpisodeFormat || DEFAULT_STANDARD_FORMAT;
}

/** True when the naming engine should rename episodes at all. */
export function shouldRenameEpisodes(config: { renameEpisodes?: boolean }): boolean {
  return config.renameEpisodes !== false;
}

/** Render the full filename (with extension) for an episode set. */
export function buildEpisodeFileName(
  input: EpisodeNamingInput,
  extension: string,
): string | null {
  if (!shouldRenameEpisodes({ renameEpisodes: input.config?.renameEpisodes })) return null;
  const format = formatForSeriesType(input.seriesType, input.config ?? {});
  if (!format.trim()) return null;
  const base = renderEpisodeName(input, format);
  if (!base) return null;
  return `${base}${extension}`;
}
