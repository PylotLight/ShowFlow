export interface ParsedFilename {
  show: string;
  season?: number;
  episodes?: number[];
  absoluteNumbers?: number[];
}

export class FilenameParser {
  /**
   * Typical release metadata that must not be interpreted as episode numbers.
   * This is deliberately applied after filename extension and bracketed
   * release-group metadata are removed.
   */
  private static readonly NOISE_PATTERN =
    /\b(?:2160p|1080p|720p|576p|480p|web[ ._-]?dl|webrip|blu[ ._-]?ray|bluray|hdtv|dvdrip|bdrip|x264|x265|h[ ._-]?264|h[ ._-]?265|hevc|av1|aac\d*|flac|opus|10bit|8bit|repack|proper|remux|dual[ ._-]?audio|multi[ ._-]?audio)\b/gi;

  /**
   * Square and curly brackets are normally release groups, hashes, or tags.
   * Parentheses are also treated as release-group tags — they frequently
   * contain release groups or resolution tags that shouldn't leak into the
   * search title. Season/episode data is captured by the patterns below
   * before this cleanup, not from bracketed content.
   */
  private static readonly BRACKETED_TAG_PATTERN = /\[[^\]\[]*]|\{[^}{]*}|\([^()]*\)/g;

  /**
   * Order matters. Explicit season/episode formats must be resolved before
   * absolute numbering.
   */
  private readonly patterns: RegExp[] = [
    // Show.S01E01, Show S1 E1, Show-S01E01-03
    /^(?<show>.+?)[. _-]+S(?<season>\d{1,2})[. _-]*E(?<episode>\d{1,3}(?:[. _,-]+\d{1,3})*)\b/i,

    // Show.1x01, Show 1x01-03
    /^(?<show>.+?)[. _-]+(?<season>\d{1,2})x(?<episode>\d{1,3}(?:[. _,-]+\d{1,3})*)\b/i,

    // Show Season 02 Episode 03, Show Season 02 Episode 03-04
    /^(?<show>.+?)[. _-]+Season[. _-]+(?<season>\d{1,2})[. _-]+Episode[. _-]+(?<episode>\d{1,3}(?:[. _,-]+\d{1,3})*)\b/i,

    // Show Season 2 Ep 3, Show Season 2 E03
    /^(?<show>.+?)[. _-]+Season[. _-]+(?<season>\d{1,2})[. _-]+E(?:p(?:isode)?)?[. _-]*(?<episode>\d{1,3}(?:[. _,-]+\d{1,3})*)\b/i,

    // Season without an explicit 'E' marker:
    // "Youjo Senki S2 - 05", "Show S2 05", "Show.S2.05",
    // And also the E-prefixed variant, which is tried first by the SxxExx pattern.
    /^(?<show>.+?)[. _-]+S(?<season>\d{1,2})[. _-]+(?:E(?:p(?:isode)?)?[. _-]*)?(?<episode>\d{1,3}(?:[. _,-]+\d{1,3})*)\b/i,
  ];

  parse(filename: string): ParsedFilename | null {
    const baseName = this.removeExtension(filename);
    const normalized = this.normalizeReleaseName(baseName);

    for (const pattern of this.patterns) {
      const match = normalized.match(pattern);
      if (!match?.groups) continue;

      const show = this.cleanShowName(match.groups.show ?? '');
      const season = this.parsePositiveInteger(match.groups.season);
      const episodes = this.parseEpisodeRange(match.groups.episode ?? '');

      if (!show || !season || episodes.length === 0) continue;

      return {
        show,
        season,
        episodes,
      };
    }

    // Single absolute episode number (no season marker), possibly preceded
    // by an E prefix: "One Piece E1050", "Show.E1050"
    const absoluteMatch = normalized.match(
      /^(?<show>.+?)[. _-]*(?:^|[. _-])E?(?<absolute>\d{1,4}(?:[. _,-]+\d{1,4})*)\b/i
    );

    if (!absoluteMatch?.groups) return null;

    const show = this.cleanShowName(absoluteMatch.groups.show ?? '');
    const absoluteNumbers = this.parseEpisodeRange(
      absoluteMatch.groups.absolute ?? ''
    );

    if (!show || absoluteNumbers.length === 0) return null;

    return {
      show,
      absoluteNumbers,
    };
  }

  private removeExtension(filename: string): string {
    return filename.replace(/\.[^.\\/]+$/, '');
  }

  private normalizeReleaseName(input: string): string {
    return input
      .normalize('NFKC')
      .replace(FilenameParser.BRACKETED_TAG_PATTERN, ' ')
      .replace(FilenameParser.NOISE_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseEpisodeRange(range: string): number[] {
    const values = range
      .split(/[. _,/-]+/)
      .filter(Boolean)
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isInteger(value) && value > 0);

    return [...new Set(values)];
  }

  private parsePositiveInteger(value: string | undefined): number | undefined {
    if (!value) return undefined;

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  private cleanShowName(raw: string): string {
    return raw
      .normalize('NFKC')
      .replace(/[._]+/g, ' ')
      .replace(/[‐‑‒–—]/g, '-')
      // Removes only an episode separator stranded at the end of the title.
      .replace(/\s+-\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * Release-quality / rendering noise tokens that should not leak into a
 * human-facing name. Matches the tokens Sonarr drops from its clean titles
 * ({Episode Clean Title}) so ShowFlow's displayed file names line up with the
 * Sonarr standard instead of embedding "WEBRip-1080p" / "Bluray-1080p Remux".
 */
const RELEASE_NOISE_PATTERN =
  /\b(?:2160p|1440p|1080p|720p|576p|480p|360p|web[ ._-]?dl|web[ ._-]?rip|blu[ ._-]?ray|hdtv|dvd[ ._-]?rip|bd[ ._-]?rip|hd[ ._-]?rip|x264|x265|h[ ._-]?264|h[ ._-]?265|hevc|av1|10bit|8bit|hdr10|hdr|dolby[ ._-]?vision|dv|remux|repack|proper|extended|aac\d*|ac3|eac3?\d*|ddp\d*|flac|opus|truehd|dts[ ._-]?hd(?:[ ._-]?(?:ma|x))?|atmos|multilang(?:uages?)?|multi[ ._-]?audio|dual[ ._-]?audio|speakeasy|constantly|scale[ ._-]?web)\b/gi;

/** Quietly removes the container extension from a filename for display. */
export function removeContainerExtension(name: string): string {
  return name.replace(/\.[^.\/\\]+$/, '');
}

/**
 * Strips release-quality/noise tokens from a file name for display, keeping
 * the on-disk filename untouched. Transforms
 * "Reacher - S04E01 - City of Brotherly Love WEBRip-1080p.mkv" into
 * "Reacher - S04E01 - City of Brotherly Love" - the same clean title logic
 * Sonarr applies to "{Episode Clean Title}".
 */
export function cleanReleaseName(name: string): string {
  let cleaned = removeContainerExtension(name)
    .replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ')
    .replace(RELEASE_NOISE_PATTERN, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/[-\s]+$/, '')
    .trim();
  return cleaned || removeContainerExtension(name).trim();
}
