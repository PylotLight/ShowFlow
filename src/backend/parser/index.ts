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
   * Parentheses are retained initially because they can contain part of a
   * real series title; resolution tags inside them are stripped by noise
   * cleanup instead.
   */
  private static readonly BRACKETED_TAG_PATTERN = /\[[^\]]*]|\{[^}]*}/g;

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

    const absoluteMatch = normalized.match(
      /^(?<show>.+?)(?:[. _-]+E)?[. _-]+(?<absolute>\d{1,4}(?:[. _,-]+\d{1,4})*)\b/i
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
