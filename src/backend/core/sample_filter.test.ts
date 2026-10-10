import { test, expect, describe } from "bun:test";
import { isSampleFile, filterOutSamples } from "./sample_filter";

describe("isSampleFile", () => {
  test.each([
    "Show.S01E01.1080p.WEB-DL.x264-GRP-sample.mkv",
    "show.s01e01.1080p.web.x264-grp.sample.mkv",
    "sample-grp-show.s01e01.mkv",
    "Sample.mkv",
    "Show.S01E01/Sample/show.s01e01.1080p.mkv",
    "Show S01E01 [Sample].mkv",
    "Samples/clip.mp4",
  ])("flags %s", (p) => expect(isSampleFile(p)).toBe(true));

  test.each([
    "Show.S01E01.1080p.WEB-DL.x264-GRP.mkv",
    "Sampler.Show.S01E01.mkv",
    "The.Exampleshow.S02E03.mkv",
    "Resample.Theory.S01E01.mkv",
  ])("keeps %s", (p) => expect(isSampleFile(p)).toBe(false));
});

describe("filterOutSamples", () => {
  const GB = 1024 ** 3;
  test("drops the sample from a single-episode torrent (either order)", () => {
    const main = { name: "Show.S01E01.1080p-GRP/Show.S01E01.1080p-GRP.mkv", size: 2 * GB };
    const sample = { name: "Show.S01E01.1080p-GRP/Sample/show.s01e01.1080p-grp.sample.mkv", size: 50 * 1024 ** 2 };
    expect(filterOutSamples([main, sample])).toEqual([main]);
    expect(filterOutSamples([sample, main])).toEqual([main]);
  });

  test("drops tiny unlabelled clips next to a big episode", () => {
    const main = { name: "ep.mkv", size: 1.5 * GB };
    const clip = { name: "rarbg.mkv", size: 20 * 1024 ** 2 };
    expect(filterOutSamples([main, clip])).toEqual([main]);
  });

  test("keeps every episode of a season pack", () => {
    const pack = Array.from({ length: 8 }, (_, i) => ({ name: `Show.S01E0${i + 1}.mkv`, size: (1 + i * 0.05) * GB }));
    expect(filterOutSamples(pack)).toHaveLength(8);
  });

  test("a torrent that is only a sample yields nothing", () => {
    expect(filterOutSamples([{ name: "Show.S01E01-sample.mkv", size: 40 * 1024 ** 2 }])).toEqual([]);
  });

  test("files without sizes are only filtered by name", () => {
    expect(filterOutSamples([{ name: "a.mkv" }, { name: "b.mkv" }, { name: "c-sample.mkv" }])).toHaveLength(2);
  });
});
