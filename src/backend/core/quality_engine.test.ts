import { test, expect, describe } from "bun:test";
import { db, DatabaseManager } from "../db";
import { qualityEngine, mergeProbeWithRelease } from "./quality_engine";
import { scoreTerms, builtinTermsIn, BUILTIN_TERMS, type ResolvedTerm } from "./quality_terms";
import { saveProfileModel, getProfileModel, convertLegacyProfiles, saveCustomTerm, removeCustomTerm } from "../db/quality_model";
import { testReleaseName } from "./release_test";
import { getProfileCutoff, isCutoffMet } from "./cutoff";
import { sonarrProfileToModel } from "../providers/sonarr/profile_map";

const RUN = `qe_${Date.now().toString(36)}`;
const pid = (s: string) => `${RUN}_${s}`;

const term = (termId: string, mode: ResolvedTerm["mode"], weight: number | null = null): ResolvedTerm => {
  const b = BUILTIN_TERMS.find(t => t.id === termId)!;
  return { termId, label: b.label, group: b.group, mode, weight, regex: null };
};

describe("term library", () => {
  test("every HEVC spelling is one term, counted once", () => {
    const t = [term("hevc", "prefer")];
    for (const name of ["S01E01.1080p.x265", "S01E01.1080p.X.265", "S01E01.h265", "S01E01.H.265", "S01E01.h-265", "S01E01.HEVC", "S01E01.hvc1", "S01E01 x265 HEVC H.265"]) {
      expect(scoreTerms(name, t).score).toBe(100);
    }
    // bare absolute episode number is not a codec
    expect(scoreTerms("[SubsPlease] One Piece - 265 (1080p)", t).score).toBe(0);
  });

  test("tricky tags", () => {
    expect(builtinTermsIn("Show.S01E01.DVDRip.x264")).not.toContain("dv");
    // classification picks the specific HDR term; scoring still lets "Any HDR" match DV
    expect(builtinTermsIn("Show.S01E01.2160p.DV.HDR10.HEVC")).toEqual(expect.arrayContaining(["dv", "hevc"]));
    expect(scoreTerms("Show.S01E01.2160p.DV.HEVC", [term("hdr", "prefer")]).score).toBe(100);
    expect(builtinTermsIn("Show S01 MULTi 1080p")).toContain("multi");
    expect(builtinTermsIn("Show S01 Multi-Subs 1080p")).toEqual(expect.arrayContaining(["multi_subs"]));
    expect(builtinTermsIn("Show S01 Multi-Subs 1080p")).not.toContain("multi");
    expect(builtinTermsIn("[SubsPlease] Frieren - 01 (1080p) [ABCD].mkv")).toContain("g_subsplease");
    expect(builtinTermsIn("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb")).toEqual(expect.arrayContaining(["ddp", "avc", "g_ntb"]));
    expect(builtinTermsIn("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv")).toContain("g_ntb");
    expect(builtinTermsIn("[Team] Frieren - 01 VOSTFR 1080p")).toContain("vostfr");
  });

  test("must / never / custom weights", () => {
    const custom: ResolvedTerm = { termId: "custom:x", label: "Team", group: "custom", mode: "prefer", weight: 42, regex: "\\[Team\\]" };
    const r = scoreTerms("[Team] Show - 01 1080p x265", [term("hevc", "strong_prefer"), custom, term("vostfr", "never"), term("dual_audio", "must")]);
    expect(r.score).toBe(342);
    expect(r.neverMatched).toBeNull();
    expect(r.missingMust).toEqual(["Dual audio"]);
    const bad: ResolvedTerm = { ...custom, regex: "([" };
    expect(scoreTerms("x", [bad]).hits[0]!.invalid).toBe(true);
  });
});

describe("streamlined scoring", () => {
  test("strong avoid: VOSTFR x265 loses to clean SubsPlease", () => {
    saveProfileModel(db, { id: pid("anime"), name: "Anime", terms: [{ termId: "hevc", mode: "prefer" }, { termId: "vostfr", mode: "strong_avoid" }] });
    const clean = qualityEngine.getReleaseScore("[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv", pid("anime"));
    const vostfr = qualityEngine.getReleaseScore("[Team] Frieren - 01 VOSTFR 1080p x265", pid("anime"));
    const hevc = qualityEngine.getReleaseScore("[Erai-raws] Frieren - 01 [1080p][HEVC]", pid("anime"));
    expect(vostfr.totalScore).toBeLessThan(clean.totalScore);
    expect(hevc.totalScore).toBeGreaterThan(clean.totalScore);
    expect(hevc.formatScore).toBe(100);
  });

  test("fixed source order: Remux > BluRay > WEB-DL > unknown > WEBRip > HDTV", () => {
    saveProfileModel(db, { id: pid("std"), name: "Std" });
    const t = (n: string) => qualityEngine.getReleaseScore(n, pid("std")).totalScore;
    const remux = t("Show.S01E01.1080p.BluRay.REMUX.AVC");
    const bluray = t("Show.S01E01.1080p.BluRay.x264");
    const webdl = t("Show.S01E01.1080p.WEB-DL.H.264");
    const unknown = t("[Group] Show - 01 (1080p)");
    const webrip = t("Show.S01E01.1080p.WEBRip.x264");
    const hdtv = t("Show.S01E01.1080p.HDTV.x264");
    expect([remux, bluray, webdl, unknown, webrip, hdtv]).toEqual([...[remux, bluray, webdl, unknown, webrip, hdtv]].sort((a, b) => b - a));
    expect(new Set([remux, bluray, webdl, unknown, webrip, hdtv]).size).toBe(6);
    expect(t("Show.S01E01.720p.BluRay.REMUX")).toBeLessThan(hdtv);
    const uhd = qualityEngine.getReleaseScore("Show S01E01 4K HDR", pid("std"));
    expect(uhd.resolution).toBe(2160);
    expect(uhd.qualityName).toBe("2160p");
  });

  test("resolution target/min, unknown toggle, skipped sources", () => {
    saveProfileModel(db, { id: pid("res"), name: "Res", minResolution: 720, targetResolution: 1080, allowUnknownResolution: false, skipSources: ["hdtv"] });
    const s = (n: string) => qualityEngine.getReleaseScore(n, pid("res"));
    expect(s("Show.S01E01.2160p.WEB-DL").rejectCode).toBe("QUALITY_NOT_ALLOWED");
    expect(s("Show.S01E01.480p.WEB-DL").rejectCode).toBe("QUALITY_NOT_ALLOWED");
    expect(s("Show.S01E01.WEB-DL").rejectCode).toBe("QUALITY_UNKNOWN");
    expect(s("Show.S01E01.1080p.HDTV").rejectReason).toContain("HDTV is skipped");
    expect(s("Show.S01E01.720p.WEB-DL").rejected).toBe(false);
    saveProfileModel(db, { id: pid("res"), name: "Res", allowUnknownResolution: true });
    expect(s("Show.S01E01.WEB-DL").rejected).toBe(false);
  });

  test("custom regex terms score with their weight and disappear when deleted", () => {
    saveCustomTerm(db, { id: `${RUN}_ct`, name: "Team", regex: "\\[Team\\]" });
    saveProfileModel(db, { id: pid("ct"), name: "Ct", terms: [{ termId: `custom:${RUN}_ct`, mode: "avoid", weight: -50 }] });
    expect(qualityEngine.getReleaseScore("[Team] Show - 01 (1080p)", pid("ct")).formatScore).toBe(-50);
    removeCustomTerm(db, `${RUN}_ct`);
    expect(getProfileModel(db, pid("ct"))!.terms).toEqual([]);
  });

  test("upgrades off really means off: no import replacement either", () => {
    saveProfileModel(db, { id: pid("off"), name: "Off", upgradesEnabled: false });
    saveProfileModel(db, { id: pid("on"), name: "On", upgradesEnabled: true });
    const old = "Show.S01E01.720p.HDTV.x264", better = "Show.S01E01.1080p.WEB-DL.x264";
    expect(qualityEngine.shouldUpgrade(old, better, pid("on"))).toBe(true);
    expect(qualityEngine.shouldUpgrade(old, better, pid("off"))).toBe(false);
    const probe = { video: { codec: "h264", width: 1280, height: 720, hdr: false } as any, audio: [], overallBitrate: 3_000_000, fileSize: 1 };
    expect(qualityEngine.shouldUpgradeWithMedia(probe, "Show - S01E01.mkv", better, pid("on"))).toBe(true);
    expect(qualityEngine.shouldUpgradeWithMedia(probe, "Show - S01E01.mkv", better, pid("off"))).toBe(false);
    expect(getProfileCutoff(db, pid("off"))).toBeNull();
  });

  test("probed files assume the best source; a stored release title can override", () => {
    saveProfileModel(db, { id: pid("probe"), name: "Probe", upgradesEnabled: true });
    const probe = { video: { codec: "h264", width: 1920, height: 1080, hdr: false } as any, audio: [{ codec: "eac3" } as any], overallBitrate: 6_000_000, fileSize: 1 };
    const s = qualityEngine.getReleaseScoreFromMedia(probe, pid("probe"));
    expect(s.qualityName).toBe("1080p");
    expect(s.totalScore).toBe(37000);
    expect(qualityEngine.shouldUpgradeWithMedia(probe, "x.mkv", "Show.S01E01.1080p.WEB-DL.H.264", pid("probe"))).toBe(false);
    expect(qualityEngine.shouldUpgradeWithMedia(probe, "x.mkv", "Show.S01E01.1080p.WEB-DL.H.264", pid("probe"), "Show.S01E01.1080p.WEBRip.x264")).toBe(true);
    const merged = mergeProbeWithRelease(s, qualityEngine.getReleaseScore("Show.S01E01.1080p.WEBRip.x264", pid("probe")));
    expect(merged.qualityName).toBe("WEBRip-1080p");
  });

  test("upgrade until quality, and until a term score", () => {
    saveProfileModel(db, { id: pid("until"), name: "Until", upgradesEnabled: true, upgradeUntilResolution: 1080, upgradeUntilSource: "webdl", upgradeUntilScore: 100, terms: [{ termId: "hevc", mode: "prefer" }] });
    const c = getProfileCutoff(db, pid("until"))!;
    expect(c.name).toBe("WEBDL-1080p");
    expect(isCutoffMet({ rank: 33, qualityName: "WEBRip-1080p", termScore: 100 }, c)).toBe(false);
    expect(isCutoffMet({ rank: 35, qualityName: "WEBDL-1080p", termScore: 0 }, c)).toBe(false);
    expect(isCutoffMet({ rank: 35, qualityName: "WEBDL-1080p", termScore: 100 }, c)).toBe(true);
    expect(isCutoffMet({ rank: 34, qualityName: "1080p", termScore: 100 }, c)).toBe(true); // probed bare 1080p
  });

  test("test box breakdown", () => {
    saveProfileModel(db, { id: pid("box"), name: "Box", upgradesEnabled: true, upgradeUntilResolution: 1080, upgradeUntilSource: "webdl", terms: [{ termId: "hevc", mode: "prefer" }, { termId: "vostfr", mode: "strong_avoid" }] });
    const r = testReleaseName("[Team] Frieren - 01 VOSTFR 1080p WEBRip x265", pid("box"));
    expect(r.resolution).toBe(1080);
    expect(r.source).toBe("WEBRip");
    expect(r.quality).toEqual({ name: "WEBRip-1080p", rank: 33 });
    expect(r.termScore).toBe(-200);
    expect(r.totalScore).toBe(33000 - 200);
    expect(r.allowed).toBe(true);
    expect(r.terms.filter(t => t.matched).map(t => t.termId).sort()).toEqual(["hevc", "vostfr"]);
    expect(r.cutoff).toEqual({ name: "WEBDL-1080p", rank: 35, met: false, minTermScore: null });
  });
});

describe("sonarr profile -> model", () => {
  test("allowed + cutoff + upgradeAllowed", () => {
    const m = sonarrProfileToModel({
      id: 4, name: "HD-1080p", upgradeAllowed: true, cutoff: 3,
      items: [
        { quality: { id: 1, name: "HDTV-720p" }, allowed: false },
        { quality: { id: 2, name: "WEBRip-1080p" }, allowed: true },
        { quality: { id: 3, name: "WEBDL-1080p" }, allowed: true },
        { quality: { id: 4, name: "Bluray-1080p" }, allowed: true },
        { quality: { id: 5, name: "WEBDL-720p" }, allowed: true },
      ],
    }, "sonarr-4");
    expect(m).toMatchObject({ minResolution: 720, targetResolution: 1080, upgradesEnabled: true, upgradeUntilResolution: 1080, upgradeUntilSource: "webdl" });
    expect(m.skipSources).toEqual(["remux", "hdtv", "dvd", "sdtv"]);
  });
});

describe("boot conversion persists once", () => {
  test("legacy profiles become model v2, idempotent", () => {
    const mem = new DatabaseManager(":memory:");
    // boot already converted the seeded Standard/Anime profiles
    expect(getProfileModel(mem, "standard")!.modelVersion).toBe(2);
    expect(getProfileModel(mem, "standard")!.terms.map(t => t.termId).sort()).toEqual(["hdr", "hevc"]);
    mem.saveQuality({ id: "q_webdl_1080p", name: "WEBDL-1080p", rank: 33 });
    mem.saveProfile({ id: "legacy", name: "Legacy", cutoffId: "q_webdl_1080p" });
    mem.saveCustomFormat({ id: "f_vost", name: "VOSTFR", regex: "vostfr", score: -50 });
    mem.saveCustomFormat({ id: "f_x265b", name: "x265", regex: "x265", score: 50 });
    mem.saveCustomFormat({ id: "f_team", name: "Team", regex: "\\[Team\\]", score: 25 });
    for (const f of ["f_vost", "f_x265b", "f_team"]) mem.addProfileFormat("legacy", f);
    // before persisting the engine reads it converted in memory
    expect(getProfileModel(mem, "legacy")!.modelVersion).toBe(0);
    const first = convertLegacyProfiles(mem);
    expect(first.map(c => c.profileId)).toEqual(["legacy"]);
    expect(convertLegacyProfiles(mem)).toEqual([]);
    const m = getProfileModel(mem, "legacy")!;
    expect(m.modelVersion).toBe(2);
    expect(m.upgradesEnabled).toBe(true);
    expect(m.terms).toEqual(expect.arrayContaining([
      { termId: "vostfr", mode: "strong_avoid", weight: null },
      { termId: "hevc", mode: "prefer", weight: null },
      { termId: "custom:f_team", mode: "prefer", weight: 25 },
    ]));
    mem.close();
  });
});
