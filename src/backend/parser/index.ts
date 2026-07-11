export interface ParsedFilename {
  show: string;
  season?: number;
  episodes?: number[];
  absoluteNumbers?: number[];
}

export class FilenameParser {
  // Release-group noise that shows up next to episode numbers but isn't part
  // of them - stripped before the absolute-number fallback so we don't
  // mistake "1080p" or similar for episode 1080.
  private static readonly NOISE_PATTERN =
    /\b(2160p|1080p|720p|480p|4k|web-?dl|webrip|bluray|blu-ray|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac\d?|10bit|repack|proper)\b/gi;

  private patterns: RegExp[] = [
    // S01E01 / S1E1 / S01.E01 / S01E01-02-03
    /(?<show>.+?)[. _-]?S(?<season>\d{1,2})[. _-]?E(?<episode>\d{1,3}(?:[-.,\s]\d{1,3})*)/i,
    // 1x01 / 1x01-02
    /(?<show>.+?)[. _-]?(?<season>\d{1,2})x(?<episode>\d{1,3}(?:[-.,\s]\d{1,3})*)/i,
  ];

  parse(filename: string): ParsedFilename | null {
    const extMatch = filename.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0] : '';
    const cleanName = ext ? filename.slice(0, -ext.length) : filename;

    for (const regex of this.patterns) {
      const match = cleanName.match(regex);
      if (match?.groups) {
        const { show, season, episode } = match.groups;
        return {
          show: this.cleanShowName(show!),
          season: season ? parseInt(season, 10) : undefined,
          episodes: this.parseEpisodeRange(episode!),
        };
      }
    }

    // Fallback: absolute numbering (e.g. "One.Piece.E1050.mkv", common in anime
    // releases that don't follow SxxExx). Strip quality/codec noise first so
    // we don't grab "1080p" instead of the real episode number.
    const denoised = cleanName.replace(FilenameParser.NOISE_PATTERN, '').trim();
    const absoluteMatch = denoised.match(/(?<show>.+?)[. _-]?e?(?<absolute>\d{2,4}(?:[-.,\s]\d{2,4})*)(?:[. _-]|$)/i);

    if (absoluteMatch?.groups) {
      const { show, absolute } = absoluteMatch.groups;
      return {
        show: this.cleanShowName(show!),
        absoluteNumbers: this.parseEpisodeRange(absolute!),
      };
    }

    return null;
  }

  private parseEpisodeRange(range: string): number[] {
    return range
      .split(/[-.,\s]+/)
      .filter(Boolean)
      .map(n => parseInt(n, 10));
  }

  private cleanShowName(raw: string): string {
    return raw.trim().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
