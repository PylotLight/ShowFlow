import { test, describe, expect } from "bun:test";

import {
  renderEpisodeName,
  buildEpisodeFileName,
  parseQualityTokens,
  formatForSeriesType,
  DEFAULT_STANDARD_FORMAT,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_ANIME_FORMAT,
  type NamingConfig,
} from "./episode_naming";

const baseInput = {
  seriesTitle: "The Series Title's",
  originalFilename: "The.Series.Title's.S01E01.WEBRip.1080p.HEVC.x265.NSW.mkv",
  media: { height: 1080, codec: "hevc", hdr: false, audioCodec: "eac3", audioChannels: 6, container: "mkv" },
};

describe("parseQualityTokens", () => {
  test("extracts source, resolution, proper, and group from a release name", () => {
    const t = parseQualityTokens("Show.Name.S01E01.WEBRip.1080p.HEVC.Proper.mkv");
    expect(t.source).toBe("WEBRip");
    expect(t.resolution).toBe("1080p");
    expect(t.proper).toBe("Proper");
  });

  test("maps Remux to BluRay source", () => {
    const t = parseQualityTokens("Show.S01E01.BluRay.1080p.Remux.x265.mkv");
    expect(t.source).toBe("BluRay");
  });

  test("detects release group in bracket and dash forms", () => {
    expect(parseQualityTokens("Show.S01E01.1080p.NSW.mkv").group).toBe("NSW");
    expect(parseQualityTokens("[NSW] Show - S01E01.mkv").group).toBe("NSW");
  });
});

describe("renderEpisodeName", () => {
  test("renders Sonarr-standard single-episode format with quality in the name", () => {
    const out = renderEpisodeName({
      ...baseInput,
      episodes: [{ season: 1, episode: 1, title: "City of Brotherly Love" }],
    }, DEFAULT_STANDARD_FORMAT);
    expect(out).toBe("The Series Title's - S01E01 - City of Brotherly Love WEBRip-1080p");
  });

  test("renders {Quality Full} with Proper version suffix", () => {
    const out = renderEpisodeName({
      ...baseInput,
      originalFilename: "Show.S01E01.WEBRip.1080p.Proper.mkv",
      episodes: [{ season: 1, episode: 1, title: "Episode Title" }],
    }, "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}");
    expect(out).toBe("The Series Title's - S01E01 - Episode Title WEBRip-1080p Proper");
  });

  test("renders anime format with absolute episode number", () => {
    const out = renderEpisodeName({
      ...baseInput,
      originalFilename: "Show.S01E01.WEBRip.1080p.v2.mkv",
      episodes: [{ season: 1, episode: 1, absoluteNumber: 7, title: "Episode Title" }],
    }, DEFAULT_ANIME_FORMAT);
    expect(out).toBe("The Series Title's - S01E01 - Episode Title WEBRip-1080p v2");
  });

  test("extends multi-episode codes (Extend style)", () => {
    const out = renderEpisodeName({
      ...baseInput,
      episodes: [
        { season: 1, episode: 1, title: "Episode Title" },
        { season: 1, episode: 2, title: "Episode Title" },
        { season: 1, episode: 3, title: "Episode Title" },
      ],
    }, "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}");
    expect(out).toBe("The Series Title's - S01E01-02-03 - Episode Title WEBRip-1080p");
  });

  test("renders daily format from air date", () => {
    const out = renderEpisodeName({
      ...baseInput,
      seriesType: "daily",
      episodes: [{ season: 1, episode: 1, title: "Episode Title", airDate: "2013-10-30" }],
    }, DEFAULT_DAILY_FORMAT);
    expect(out).toBe("The Series Title's - 2013-10-30 - Episode Title WEBRip-1080p");
  });

  test("cleans illegal characters from the final name", () => {
    const out = renderEpisodeName({
      ...baseInput,
      episodes: [{ season: 1, episode: 1, title: "Part: 1" }],
    }, "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}");
    expect(out).toContain("Part 1");
    expect(out).not.toContain(":");
  });

  test("strips colons from the series title (Samba/macOS 8.3 mangling)", () => {
    const out = renderEpisodeName({
      ...baseInput,
      seriesTitle: "HELL MODE: The Hardcore Gamer Dominates in Another World",
      episodes: [{ season: 1, episode: 1, title: "Episode Title" }],
    }, "{Series Clean Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}");
    expect(out).not.toContain(":");
    expect(out).toContain("HELL MODE The Hardcore Gamer");
  });

  test("supports {MediaInfo} tokens", () => {
    const out = renderEpisodeName({
      ...baseInput,
      episodes: [{ season: 1, episode: 1, title: "Episode Title" }],
    }, "{Series Title} S{season:00}E{episode:00} {MediaInfo Video} {MediaInfo AudioCodec} {MediaInfo AudioChannels} {MediaInfo Full}");
    expect(out).toBe("The Series Title's S01E01 x265 EAC3 5.1 x265 1080p");
  });

  test("office style collapses to first-last", () => {
    const cfg: NamingConfig = { multiEpisodeStyle: "office" };
    const out = renderEpisodeName({
      ...baseInput,
      episodes: [
        { season: 1, episode: 1, title: "Episode Title" },
        { season: 1, episode: 2, title: "Episode Title" },
        { season: 1, episode: 3, title: "Episode Title" },
      ],
      config: cfg,
    }, "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}");
    expect(out).toBe("The Series Title's - S01E01-03 - Episode Title WEBRip-1080p");
  });
});

describe("buildEpisodeFileName", () => {
  test("appends the extension", () => {
    const out = buildEpisodeFileName({
      ...baseInput,
      episodes: [{ season: 1, episode: 1, title: "City of Brotherly Love" }],
    }, ".mkv");
    expect(out).toBe("The Series Title's - S01E01 - City of Brotherly Love WEBRip-1080p.mkv");
  });

  test("returns null when renameEpisodes is disabled", () => {
    const out = buildEpisodeFileName({
      ...baseInput,
      episodes: [{ season: 1, episode: 1, title: "City of Brotherly Love" }],
      config: { renameEpisodes: false },
    }, ".mkv");
    expect(out).toBeNull();
  });
});

describe("formatForSeriesType", () => {
  test("falls back to Sonarr defaults per series type", () => {
    expect(formatForSeriesType("daily", {})).toBe(DEFAULT_DAILY_FORMAT);
    expect(formatForSeriesType("anime", {})).toBe(DEFAULT_ANIME_FORMAT);
    expect(formatForSeriesType("standard", {})).toBe(DEFAULT_STANDARD_FORMAT);
    expect(formatForSeriesType(undefined, {})).toBe(DEFAULT_STANDARD_FORMAT);
  });
});