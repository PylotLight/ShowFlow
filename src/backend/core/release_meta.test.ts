import { test, expect } from "bun:test";
import { extractReleaseMeta, releaseGroup, releaseTitlesMatch } from "./release_meta";

const THOR = "Thor.2011.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.7.1.Atmos.MULTI-RIFE.4.25v2-60fps-DirtyHippie.mkv";

test("extracts Dolby Vision over HDR10+ (priority) from a release name", () => {
  const meta = extractReleaseMeta(THOR);
  expect(meta.hdrFormat).toBe("Dolby Vision");
});

test("surfaces filename-only quality tags a probe can't read", () => {
  const { tags } = extractReleaseMeta(THOR);
  expect(tags).toContain("Atmos");
  expect(tags).toContain("AI-Enhanced");
  expect(tags).toContain("RIFE");
});

test("doesn't invent an HDR format for an SDR name", () => {
  expect(extractReleaseMeta("Some.Show.S01E01.1080p.x264-GRP.mkv").hdrFormat).toBeNull();
});

test("distinguishes HDR10 from HDR10+ and from 10-bit SDR", () => {
  expect(extractReleaseMeta("Movie.2020.2160p.HDR10.x265").hdrFormat).toBe("HDR10");
  expect(extractReleaseMeta("Movie.2020.2160p.HDR10Plus.x265").hdrFormat).toBe("HDR10+");
  expect(extractReleaseMeta("Movie.2020.2160p.HDR.10bit.x265").hdrFormat).toBeNull();
});

test("flags dual/multi audio and source grade", () => {
  const { tags } = extractReleaseMeta("Show.S01.BluRay.1080p.x265.DTS-HD.MA.5.1.DUAL-ATMOS");
  expect(tags).toContain("BluRay");
  expect(tags).toContain("DTS-HD MA");
  expect(tags).toContain("Dual-Audio");
  expect(tags).toContain("Atmos");
});

test("blank name yields empty metadata, never throws", () => {
  expect(extractReleaseMeta(null)).toEqual({ hdrFormat: null, tags: [] });
  expect(extractReleaseMeta("").tags).toEqual([]);
});

test("releaseGroup extracts the trailing scene group, not codec/source tags", () => {
  expect(releaseGroup("Show.S01E01.1080p.WEB.H264-EPiC.mkv")).toBe("epic");
  expect(releaseGroup("Movie.2020.2160p.x265-HDR10Plus")).toBe("");  // HDR tag, not a group
  expect(releaseGroup("Movie 2020 1080p")).toBe("");                 // no trailing group
});

const FRANESTOR_GRAB = "Thor 2011 2160p BluRay REMUX DV HDR HEVC TrueHD Atmos 7.1-FraMeSToR";

test("rejects a misattributed grab whose group differs from the landed file", () => {
  // The exact bug: a FraMeSToR REMUX grab stamped onto a DirtyHippie RIFE file.
  expect(releaseTitlesMatch(FRANESTOR_GRAB, THOR)).toBe(false);
});

test("accepts a grab that names the same release as the landed file", () => {
  const landed = "Thor.2011.2160p.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FraMeSToR.mkv";
  expect(releaseTitlesMatch(FRANESTOR_GRAB, landed)).toBe(true);
});

test("falls back to token overlap when a group can't be parsed from both sides", () => {
  expect(releaseTitlesMatch("Big Movie 2021 1080p WEB-DL", "Big.Movie.2021.1080p.WEB.DL.DDP5.1.mkv")).toBe(true);
  expect(releaseTitlesMatch("Big Movie 2021 1080p WEB-DL", "Totally Different 1999 720p")).toBe(false);
});

test("never claims a match on empty input", () => {
  expect(releaseTitlesMatch("", THOR)).toBe(false);
  expect(releaseTitlesMatch(FRANESTOR_GRAB, "")).toBe(false);
});
