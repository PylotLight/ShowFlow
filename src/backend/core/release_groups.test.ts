import { test, expect, describe } from "bun:test";
import { DatabaseManager } from "../db";
import { parseReleaseGroup } from "./release_meta";
import { scoreTerms, BUILTIN_TERMS, PRESETS, TERM_GROUPS, type ResolvedTerm } from "./quality_terms";
import {
  saveProfileModel, getProfileModel, convertBuiltinGroupTerms, releaseGroupSuggestions, resolveProfileTerms, saveCustomTerm,
} from "../db/quality_model";

describe("parseReleaseGroup", () => {
  test("anime-style leading [Group]", () => {
    expect(parseReleaseGroup("[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv")).toBe("SubsPlease");
    expect(parseReleaseGroup("[Erai-raws] Show - 01 [1080p][Multiple Subtitle].mkv")).toBe("Erai-raws");
    expect(parseReleaseGroup("[Team] Frieren - 01 VOSTFR 1080p WEBRip x265")).toBe("Team");
  });
  test("scene-style trailing -GROUP", () => {
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb")).toBe("NTb");
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv")).toBe("NTb");
    expect(parseReleaseGroup("Movie.2019.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FraMeSToR")).toBe("FraMeSToR");
    expect(parseReleaseGroup("Show.S01E01.720p.HDTV.x264-KILLERS[rartv]")).toBe("KILLERS");
    expect(parseReleaseGroup("Show.S01E01.720p.HDTV.x264-KILLERS[eztv].mkv")).toBe("KILLERS");
  });
  test("no group", () => {
    expect(parseReleaseGroup("Show S01E01 1080p")).toBeNull();
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL")).toBeNull();
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-DL.x264")).toBeNull();
    expect(parseReleaseGroup("Show - 01 (1080p).mkv")).toBeNull();
    expect(parseReleaseGroup("")).toBeNull();
    expect(parseReleaseGroup(null)).toBeNull();
  });
  test("codec / quality tails aren't groups", () => {
    expect(parseReleaseGroup("Show.S01E01.1080p.WEB-x265")).toBeNull();
    expect(parseReleaseGroup("Show.S01E01.1080p-HEVC.mkv")).toBeNull();
    expect(parseReleaseGroup("Show.S01E01-1080p")).toBeNull();
    expect(parseReleaseGroup("[1080p] Show - 01.mkv")).toBeNull();
    expect(parseReleaseGroup("Show.S01E01.WEB-DL-AAC")).toBeNull();
  });
});

const g = (name: string, mode: ResolvedTerm["mode"], weight: number | null = null): ResolvedTerm =>
  ({ termId: `group:${name}`, label: name, group: "group", mode, weight, regex: null });

describe("release group terms", () => {
  test("built-in library has no release groups, Anime preset has none either", () => {
    expect(BUILTIN_TERMS.some(t => t.group === "group")).toBe(false);
    expect(TERM_GROUPS.some(t => t.id === "group")).toBe(false);
    for (const p of PRESETS) expect(p.terms.some(t => t.termId.startsWith("g_") || t.termId.startsWith("group:"))).toBe(false);
  });
  test("exact, case-insensitive match on the parsed group only", () => {
    const t = [g("subsplease", "prefer"), g("NTB", "strong_avoid")];
    expect(scoreTerms("[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv", t).score).toBe(100);
    expect(scoreTerms("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv", t).score).toBe(-300);
    // mentioned but not the group
    expect(scoreTerms("Show.S01E01.SubsPlease.Edit.1080p-OTHER", t).score).toBe(0);
    // prefix isn't a match
    expect(scoreTerms("Show.S01E01.1080p-NTbX", t).score).toBe(0);
  });
  test("must / never and numeric weight", () => {
    expect(scoreTerms("Show.S01E01-FLUX", [g("FLUX", "never")]).neverMatched).toBe("FLUX");
    expect(scoreTerms("Show.S01E01-OTHER", [g("FLUX", "must")]).missingMust).toEqual(["FLUX"]);
    expect(scoreTerms("Show.S01E01-FLUX", [g("flux", "prefer", 42)]).score).toBe(42);
  });
});

describe("profile storage + conversion", () => {
  test("save normalizes group ids, dedupes case-insensitively, maps old built-in ids", () => {
    const mem = new DatabaseManager(":memory:");
    const m = saveProfileModel(mem, {
      id: "p1", name: "P1",
      terms: [
        { termId: "group: SubsPlease ", mode: "prefer" },
        { termId: "group:subsplease", mode: "avoid" },
        { termId: "g_ntb", mode: "strong_avoid", weight: -250 },
        { termId: "hevc", mode: "prefer" },
      ],
    });
    expect(m.terms).toHaveLength(3);
    expect(m.terms).toEqual(expect.arrayContaining([
      { termId: "group:SubsPlease", mode: "prefer", weight: null },
      { termId: "group:NTb", mode: "strong_avoid", weight: -250 },
      { termId: "hevc", mode: "prefer", weight: null },
    ]));
    expect(resolveProfileTerms(mem, m).find(t => t.termId === "group:NTb")).toMatchObject({ label: "NTb", group: "group" });
    expect(() => saveProfileModel(mem, { id: "p1", name: "P1", terms: [{ termId: "group:   ", mode: "prefer" }] })).toThrow();
    mem.close();
  });

  test("boot conversion: built-in group rows -> group terms, same mode/weight, idempotent, custom untouched", () => {
    const mem = new DatabaseManager(":memory:");
    saveCustomTerm(mem, { id: "team", name: "Team", regex: "\\[Team\\]" });
    saveProfileModel(mem, { id: "anime2", name: "Anime 2", terms: [{ termId: "hevc", mode: "prefer" }, { termId: "custom:team", mode: "prefer", weight: 25 }] });
    // rows as an older build wrote them
    mem.db.run("INSERT INTO profile_terms (profile_id, term_id, mode, weight) VALUES ('anime2', 'g_subsplease', 'strong_prefer', NULL)");
    mem.db.run("INSERT INTO profile_terms (profile_id, term_id, mode, weight) VALUES ('anime2', 'g_erai', 'prefer', 150)");
    mem.db.run("INSERT INTO profile_terms (profile_id, term_id, mode, weight) VALUES ('anime2', 'g_ntb', 'never', NULL)");
    mem.db.run("INSERT INTO profile_terms (profile_id, term_id, mode, weight) VALUES ('anime2', 'group:ntb', 'avoid', NULL)");
    expect(convertBuiltinGroupTerms(mem)).toBe(2);
    expect(convertBuiltinGroupTerms(mem)).toBe(0);
    const terms = getProfileModel(mem, "anime2")!.terms;
    expect(terms).toEqual(expect.arrayContaining([
      { termId: "group:SubsPlease", mode: "strong_prefer", weight: null },
      { termId: "group:Erai-raws", mode: "prefer", weight: 150 },
      { termId: "group:ntb", mode: "avoid", weight: null },
      { termId: "custom:team", mode: "prefer", weight: 25 },
      { termId: "hevc", mode: "prefer", weight: null },
    ]));
    expect(terms.some(t => t.termId.startsWith("g_"))).toBe(false);
    expect(terms).toHaveLength(5);
    mem.close();
  });

  test("suggestions come from the user's own grabs + files, most frequent first", () => {
    const mem = new DatabaseManager(":memory:");
    mem.saveShow({ uuid: "s1", providerId: "p-s1", type: "tmdb", title: "Show", config: {} });
    mem.recordGrabbedRelease({ showId: "s1", season: 1, episode: 1, releaseTitle: "[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv" });
    mem.recordGrabbedRelease({ showId: "s1", season: 1, episode: 2, releaseTitle: "[SubsPlease] Show - 02 (1080p) [ABCD1235].mkv" });
    mem.recordGrabbedRelease({ showId: "s1", season: 1, episode: 3, releaseTitle: "Show.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb" });
    mem.recordGrabbedRelease({ showId: "s1", season: 1, episode: 4, releaseTitle: "Show S01E04 1080p" });
    mem.recordEpisodeFile({ showId: "s1", season: 1, episode: 5, filePath: "/lib/Show - S01E05.mkv", originalName: "[subsplease] Show - 05 (1080p).mkv" });
    const s = releaseGroupSuggestions(mem);
    expect(s).toEqual([{ name: "SubsPlease", count: 3 }, { name: "NTb", count: 1 }]);
    mem.close();
  });
});

describe("test box + migration preview show the group hit", () => {
  test("testReleaseName returns the parsed group and the hit; preview row carries groupHit", async () => {
    const { db } = await import("../db");
    const { testReleaseName } = await import("./release_test");
    const { buildMigrationPreview } = await import("./quality_migration_preview");
    const RUN = `rg_${Date.now().toString(36)}`;
    const profileId = `${RUN}_p`;
    saveProfileModel(db, { id: profileId, name: `Groups ${RUN}`, minResolution: 720, targetResolution: 1080, terms: [{ termId: "group:SubsPlease", mode: "strong_prefer" }] });
    const r = testReleaseName("[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv", profileId);
    expect(r.releaseGroup).toBe("SubsPlease");
    expect(r.terms.find(t => t.termId === "group:SubsPlease")).toMatchObject({ matched: true, weight: 300, label: "SubsPlease" });
    expect(r.termScore).toBe(300);
    expect(testReleaseName("Show.S01E01.1080p.WEB-DL-NTb", profileId).releaseGroup).toBe("NTb");

    const showId = `${RUN}_show`;
    db.saveShow({ uuid: showId, providerId: `p-${showId}`, type: "tmdb", title: `Frieren ${RUN}`, config: {} });
    db.db.run(`UPDATE shows SET profile = ?, library_type_id = NULL WHERE id = ?`, [profileId, showId]);
    db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: "[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv" });
    db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: "[Team] Frieren - 01 1080p WEBRip x265" });
    const p = buildMigrationPreview(db, { limit: 50 });
    const mine = p.releases.filter(x => x.show === `Frieren ${RUN}`);
    const sp = mine.find(x => x.title.startsWith("[SubsPlease]"))!;
    expect(sp.releaseGroup).toBe("SubsPlease");
    expect(sp.new.groupHit).toEqual({ label: "SubsPlease", mode: "strong_prefer", weight: 300 });
    const team = mine.find(x => x.title.startsWith("[Team]"))!;
    expect(team.releaseGroup).toBe("Team");
    expect(team.new.groupHit).toBeNull();
  });
});
