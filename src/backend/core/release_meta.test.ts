import { test, expect } from "bun:test";
import { extractReleaseMeta } from "./release_meta";

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
