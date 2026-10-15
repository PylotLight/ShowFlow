import { test, expect, describe } from "bun:test";
import { convertLegacyProfile, classifyFormat, groupFromRegex, type LegacyFormat } from "./quality_migration";

const f = (id: string, name: string, regex: string, score: number, type = "bonus"): LegacyFormat => ({ id, name, regex, score, type });

describe("classifyFormat", () => {
  test("aliases, resolutions, sources, unknowns", () => {
    expect(classifyFormat({ name: "x265", regex: "x265" })).toEqual({ kind: "term", termId: "hevc" });
    expect(classifyFormat({ name: "H.265", regex: "H\\.265" })).toEqual({ kind: "term", termId: "hevc" });
    // the old engine filed a bare "265" under the H.265 family, so it merges too
    expect(classifyFormat({ name: "265", regex: "265" })).toEqual({ kind: "term", termId: "hevc" });
    expect(classifyFormat({ name: "HEVC", regex: "\\b(x|h)\\.?265\\b" })).toEqual({ kind: "term", termId: "hevc" });
    expect(classifyFormat({ name: "Dolby Vision", regex: "\\b(DV|DoVi)\\b" })).toEqual({ kind: "term", termId: "dv" });
    expect(classifyFormat({ name: "HDR", regex: "HDR" })).toEqual({ kind: "term", termId: "hdr" });
    expect(classifyFormat({ name: "SubsPlease", regex: "\\[SubsPlease\\]" })).toEqual({ kind: "term", termId: "group:SubsPlease" });
    expect(classifyFormat({ name: "Erai", regex: "\\[Erai-raws\\]" })).toEqual({ kind: "term", termId: "group:Erai-raws" });
    expect(classifyFormat({ name: "NTb", regex: "-NTb$" })).toEqual({ kind: "term", termId: "group:NTb" });
    expect(classifyFormat({ name: "2160p", regex: "2160p" })).toEqual({ kind: "resolution", res: 2160 });
    expect(classifyFormat({ name: "4K", regex: "4k|uhd" })).toEqual({ kind: "resolution", res: 2160 });
    expect(classifyFormat({ name: "Remux", regex: "remux" })).toEqual({ kind: "source", source: "remux" });
    expect(classifyFormat({ name: "Team", regex: "\\[Team\\]" })).toEqual({ kind: "custom" });
    expect(classifyFormat({ name: "HEVC or VOSTFR", regex: "x265|vostfr" })).toEqual({ kind: "custom" });
  });
});

describe("convertLegacyProfile", () => {
  test("the user's Anime setup: 5 HEVC spellings + VOSTFR avoid + custom 2160p", () => {
    const c = convertLegacyProfile({
      formats: [
        f("a", "x265", "x265", 50), f("b", "HEVC", "HEVC", 50), f("c", "H265", "H265", 50),
        f("d", "265", "265", 50), f("e", "H.265", "H\\.265", 50),
        f("v", "VOSTFR", "vostfr", -50), f("k", "2160p", "2160p", 50),
        // a +100 Remux format folds into the source order; it must not make the -50 VOSTFR look "small"
        f("r", "Remux", "remux", 100),
      ],
      allowed: [],
      cutoff: null,
    });
    expect(c.terms).toEqual([
      { termId: "hevc", mode: "prefer", weight: null },
      { termId: "vostfr", mode: "strong_avoid", weight: null },
    ]);
    expect(c.targetResolution).toBe(2160);
    expect(c.minResolution).toBeNull();
    expect(c.upgradesEnabled).toBe(false);
    expect(c.notes.join("\n")).toContain("merged 5 formats (x265, HEVC, H265, 265, H.265) into HEVC / x265: prefer");
    expect(c.notes.join("\n")).toContain("upgrades are off");
  });

  test("allow-list -> min/target, source-only list -> skips, cutoff -> upgrade until", () => {
    const c = convertLegacyProfile({
      formats: [],
      allowed: [{ id: "1", name: "WEBDL-720p" }, { id: "2", name: "WEBDL-1080p" }, { id: "3", name: "Bluray-1080p" }],
      cutoff: { name: "WEBDL-1080p" },
    });
    expect(c).toMatchObject({ minResolution: 720, targetResolution: 1080, allowUnknownResolution: false, upgradesEnabled: true, upgradeUntilResolution: 1080, upgradeUntilSource: "webdl" });
    expect(c.skipSources).toEqual(["remux", "webrip", "hdtv", "dvd", "sdtv"]);

    const bare = convertLegacyProfile({ formats: [], allowed: [{ id: "1", name: "720p" }, { id: "2", name: "2160p" }], cutoff: { name: "1080p" } });
    expect(bare.skipSources).toEqual([]);
    expect(bare.upgradeUntilSource).toBeNull();
    expect(bare.notes.join()).toContain("skipped 1080p");
  });

  test("required / forbidden / weights", () => {
    const c = convertLegacyProfile({
      formats: [
        f("r", "Dual Audio", "dual[ .-]?audio", 0, "required"),
        f("x", "Hardsub", "hardsub", 0, "forbidden"),
        f("hdtv", "HDTV", "hdtv", 0, "forbidden"),
        f("4k", "2160p", "2160p", 0, "forbidden"),
        f("s", "Atmos", "atmos", 100),
        f("t", "AAC", "aac", -10),
        f("z", "FLAC", "flac", 0),
      ],
      allowed: [],
      cutoff: null,
    });
    expect(c.terms).toEqual(expect.arrayContaining([
      { termId: "dual_audio", mode: "must", weight: null },
      { termId: "hardsub", mode: "never", weight: null },
      { termId: "atmos", mode: "strong_prefer", weight: null },
      { termId: "aac", mode: "avoid", weight: null },
    ]));
    expect(c.terms.find(t => t.termId === "flac")).toBeUndefined();
    expect(c.skipSources).toEqual(["hdtv"]);
    expect(c.targetResolution).toBe(1080);
  });
});

describe("groupFromRegex", () => {
  test("bracket / trailing-dash group regexes, not codecs", () => {
    expect(groupFromRegex("\\[SubsPlease\\]")).toBe("SubsPlease");
    expect(groupFromRegex("-FraMeSToR$")).toBe("FraMeSToR");
    expect(groupFromRegex("-x265")).toBeNull();
    expect(groupFromRegex("\\[1080p\\]")).toBeNull();
    expect(groupFromRegex("x265|vostfr")).toBeNull();
  });
});
