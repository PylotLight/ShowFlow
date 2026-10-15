import { test, expect, describe } from "bun:test";
import { qualityEngine } from "./quality_engine";
import { db } from "../db";

test("QualityEngine Scoring", async () => {
  // Clear tables to ensure consistent tests (FKs off so delete order doesn't matter)
  db.db.run('PRAGMA foreign_keys = OFF');
  db.db.run('DELETE FROM quality_definitions');
  db.db.run('DELETE FROM quality_profiles');
  db.db.run('DELETE FROM custom_formats');
  db.db.run('DELETE FROM profile_formats');
  db.db.run('PRAGMA foreign_keys = ON');

  // Setup test data
  db.saveQuality({ id: 'q_720p', name: '720p', rank: 20 });
  db.saveQuality({ id: 'q_1080p', name: '1080p', rank: 30 });
  db.saveQuality({ id: 'q_2160p', name: '2160p', rank: 40 });

  db.saveProfile({ id: 'p1', name: 'High Quality' });
  db.saveCustomFormat({ id: 'f1', name: 'HDR', regex: 'HDR', score: 50 });
  db.saveCustomFormat({ id: 'f2', name: 'x265', regex: 'x265', score: 10 });
  
  db.addProfileFormat('p1', 'f1');
  db.addProfileFormat('p1', 'f2');

  const file720 = "Show.S01E01.720p.mkv";
  const file1080 = "Show.S01E01.1080p.mkv";
  const file1080HDR = "Show.S01E01.1080p.HDR.x265.mkv";
  const file2160p = "Show.S01E01.2160p.mkv";

  const score720 = qualityEngine.getReleaseScore(file720, 'p1');
  const score1080 = qualityEngine.getReleaseScore(file1080, 'p1');
  const score1080HDR = qualityEngine.getReleaseScore(file1080HDR, 'p1');
  const score2160p = qualityEngine.getReleaseScore(file2160p, 'p1');

  console.log(`Score 720: ${score720.totalScore}`);
  console.log(`Score 1080: ${score1080.totalScore}`);
  console.log(`Score 1080HDR: ${score1080HDR.totalScore}`);
  console.log(`Score 2160p: ${score2160p.totalScore}`);

  expect(score1080.totalScore).toBeGreaterThan(score720.totalScore);
  expect(score1080HDR.totalScore).toBeGreaterThan(score1080.totalScore);
  expect(score2160p.totalScore).toBeGreaterThan(score1080HDR.totalScore);

  expect(qualityEngine.shouldUpgrade(file720, file1080, 'p1')).toBe(true);
  expect(qualityEngine.shouldUpgrade(file1080HDR, file1080, 'p1')).toBe(false);
});

test("Codec families auto-match every spelling of a format", async () => {
  db.db.run('PRAGMA foreign_keys = OFF');
  db.db.run('DELETE FROM quality_definitions');
  db.db.run('DELETE FROM quality_profiles');
  db.db.run('DELETE FROM custom_formats');
  db.db.run('DELETE FROM profile_formats');
  db.db.run('PRAGMA foreign_keys = ON');

  db.saveQuality({ id: 'q_1080p', name: '1080p', rank: 30 });
  db.saveProfile({ id: 'p2', name: 'Codec Profile' });

  // A single "H.265" format should catch every spelling:
  // x265, X.265, h265, h.265, h-265, HEVC, hvc1, and bare "265".
  db.saveCustomFormat({ id: 'fh265', name: 'H.265', regex: 'H.265', score: 50 });
  db.addProfileFormat('p2', 'fh265');

  const cases = [
    "Show.S01E01.1080p.x265.mkv",
    "Show.S01E01.1080p.X.265.mkv",
    "Show.S01E01.1080p.h265.mkv",
    "Show.S01E01.1080p.H.265.mkv",
    "Show.S01E01.1080p.h-265.mkv",
    "Show.S01E01.1080p.HEVC.mkv",
    "Show.S01E01.1080p.hvc1.mkv",
    "Show.S01E01.1080p.265.mkv",
  ];
  for (const file of cases) {
    const score = qualityEngine.getReleaseScore(file, 'p2');
    expect(score.rejected).toBe(false);
    expect(score.formatScore).toBe(50);
    expect(score.matchedTags).toContain("H.265");
  }

  // A different codec must NOT match the H.265 format.
  const h264 = qualityEngine.getReleaseScore("Show.S01E01.1080p.x264.mkv", 'p2');
  expect(h264.formatScore).toBe(0);

  // Tag scanning surfaces the family label regardless of spelling.
  const tags = qualityEngine.getReleaseScore("Show.S01E01.1080p.HEVC.mkv", 'p2').matchedTags;
  expect(tags).toContain("H.265");
});

test("Media-aware scoring: cleaned stored names don't lose to lower resolutions", async () => {
  db.db.run('PRAGMA foreign_keys = OFF');
  db.db.run('DELETE FROM quality_definitions');
  db.db.run('DELETE FROM quality_profiles');
  db.db.run('DELETE FROM custom_formats');
  db.db.run('DELETE FROM profile_formats');
  db.db.run('PRAGMA foreign_keys = ON');

  db.saveQuality({ id: 'q_1080p', name: '1080p', rank: 30 });
  db.saveQuality({ id: 'q_2160p', name: '2160p', rank: 40 });
  db.saveProfile({ id: 'p3', name: 'Media Profile' });

  // The exact Reacher S04E01 scenario: a 6.5GB 2160p HEVC file stored under a
  // clean name ("Reacher - S04E01 - City of Brotherly Love.mkv") vs an
  // arriving WEBRip-1080p.
  const stored2160 = {
    video: { codec: 'hevc', width: 3840, height: 2160, fps: 23.976, codedWidth: 3840, codedHeight: 2160, bitrate: null, averageBitrate: null, hdr: false },
    audio: [{ codec: 'eac3', channels: 6, sampleRate: 48000, bitrate: null, averageBitrate: null }],
    overallBitrate: 18_731_592,
    fileSize: 6_510_427_156,
  };

  // Filename-only comparison says the WEBRip IS an upgrade -> the root cause.
  const cleanName = "Reacher - S04E01 - City of Brotherly Love.mkv";
  const arriving1080 = "Reacher.S04E01.WEBRip.1080p.HEVC.x265.mkv";
  expect(qualityEngine.shouldUpgrade(cleanName, arriving1080, 'p3')).toBe(true);

  // Media-aware comparison sees the stored 2160p and correctly refuses.
  expect(qualityEngine.shouldUpgradeWithMedia(stored2160, cleanName, arriving1080, 'p3')).toBe(false);

  // A real 2160p arrival still upgrades a stored 1080p.
  const stored1080 = {
    video: { codec: 'hevc', width: 1920, height: 960, fps: 23.976, codedWidth: 1920, codedHeight: 960, bitrate: null, averageBitrate: null, hdr: false },
    audio: [{ codec: 'eac3', channels: 6, sampleRate: 48000, bitrate: null, averageBitrate: null }],
    overallBitrate: 1_828_638,
    fileSize: 635_562_686,
  };
  const arriving2160 = "Reacher.S04E01.2160p.WEBDL.HEVC.mkv";
  expect(qualityEngine.shouldUpgradeWithMedia(stored1080, cleanName, arriving2160, 'p3')).toBe(true);

  // getReleaseScoreFromMedia matches a 2160p tag to the 2160p quality rank.
  const s = qualityEngine.getReleaseScoreFromMedia(stored2160, 'p3');
  expect(s.rejected).toBe(false);
  expect(s.qualityName).toBe('2160p');
});

// ---- Real release names, seeded tiers, de-duped formats --------------------

import { mergeProbeWithRelease, formatGroupKey } from "./quality_engine";
import { testReleaseName } from "./release_test";
import seedManifest from "../db/seed/manifest.json";

function resetQualityTables() {
  db.db.run('PRAGMA foreign_keys = OFF');
  db.db.run('DELETE FROM quality_definitions');
  db.db.run('DELETE FROM quality_profiles');
  db.db.run('DELETE FROM custom_formats');
  db.db.run('DELETE FROM profile_formats');
  db.db.run('DELETE FROM profile_qualities');
  db.db.run('PRAGMA foreign_keys = ON');
  for (const q of seedManifest.qualities) db.saveQuality(q);
}

/** The user's Anime setup: five HEVC spellings (+50 each) and VOSTFR avoid. */
function seedAnimeProfile() {
  resetQualityTables();
  db.saveProfile({ id: 'anime', name: 'Anime' });
  const formats = [
    { id: 'f_x265', name: 'x265', regex: 'x265', score: 50 },
    { id: 'f_hevc', name: 'HEVC', regex: 'HEVC', score: 50 },
    { id: 'f_h265', name: 'H265', regex: 'H265', score: 50 },
    { id: 'f_265', name: '265', regex: '265', score: 50 },
    { id: 'f_h.265', name: 'H.265', regex: 'H\\.265', score: 50 },
    { id: 'f_vostfr', name: 'VOSTFR', regex: 'vostfr', score: -50 },
  ];
  for (const f of formats) {
    db.saveCustomFormat(f);
    db.addProfileFormat('anime', f.id);
  }
}

describe("real-world release names", () => {
  test("source tiers rank: Remux > BluRay > WEB-DL > WEBRip at the same resolution", () => {
    resetQualityTables();
    db.saveProfile({ id: 'std', name: 'Standard' });
    const s = (n: string) => qualityEngine.getReleaseScore(n, 'std');
    const remux = s('Show.S01E01.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-FraMeSToR');
    const bluray = s('Show.S01E01.1080p.BluRay.x264-GRP');
    const webdl = s('Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-NTb');
    const webrip = s('Show.S01E01.1080p.WEBRip.x264-GRP');
    expect(remux.qualityName).toBe('Remux-1080p');
    expect(webdl.qualityName).toBe('WEBDL-1080p');
    expect(webdl.source).toBe('webdl');
    expect(webdl.resolution).toBe(1080);
    expect(remux.totalScore).toBeGreaterThan(bluray.totalScore);
    expect(bluray.totalScore).toBeGreaterThan(webdl.totalScore);
    expect(webdl.totalScore).toBeGreaterThan(webrip.totalScore);
    expect(qualityEngine.shouldUpgrade('Show.S01E01.1080p.WEBRip.x264-GRP', 'Show.S01E01.1080p.WEB-DL.H.264-NTb', 'std')).toBe(true);
  });

  test("2160p UHD HDR and bare 4K names parse as 2160p", () => {
    resetQualityTables();
    db.saveProfile({ id: 'std', name: 'Standard' });
    expect(qualityEngine.getReleaseScore('Show.S01E01.2160p.WEB-DL.DV.HDR.H.265-FLUX', 'std').qualityName).toBe('WEBDL-2160p');
    expect(qualityEngine.getReleaseScore('Show.S01E01.UHD.BluRay.REMUX.HDR.HEVC.Atmos', 'std').qualityName).toBe('Remux-2160p');
    const fourK = qualityEngine.getReleaseScore('Show S01E01 4K HDR', 'std');
    expect(fourK.qualityName).toBe('2160p');
    expect(fourK.rank).toBe(40);
  });

  test("HEVC spellings count once: x265/HEVC/H265/265/H.265 no longer stack", () => {
    seedAnimeProfile();
    const erai = qualityEngine.getReleaseScore('[Erai-raws] Frieren - 01 [1080p][HEVC][Multiple Subtitle].mkv', 'anime');
    expect(erai.formatScore).toBe(50);
    expect(erai.totalScore).toBe(30050);
    const res = qualityEngine.calculateFormatScore('[Erai-raws] Frieren - 01 [1080p][HEVC].mkv', 'anime');
    expect(res.matchedFormats).toHaveLength(1);
    const deduped = res.hits.filter(h => h.deduped);
    expect(deduped.map(h => h.name).sort()).toEqual(['265', 'H.265', 'H265', 'HEVC', 'x265'].filter(n => n !== res.matchedFormats[0]).sort());
    expect(deduped.every(h => h.countedAs === res.matchedFormats[0])).toBe(true);
  });

  test("VOSTFR x265 no longer outscores clean SubsPlease by +200", () => {
    seedAnimeProfile();
    const subsplease = qualityEngine.getReleaseScore('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv', 'anime');
    const vostfr = qualityEngine.getReleaseScore('[Team] Frieren - 01 VOSTFR 1080p x265', 'anime');
    expect(subsplease.totalScore).toBe(30000);
    expect(subsplease.qualityName).toBe('1080p');
    // +50 HEVC (once) -50 VOSTFR: a tie with clean, not a +200 win.
    expect(vostfr.formatScore).toBe(0);
    expect(vostfr.totalScore).toBeLessThanOrEqual(subsplease.totalScore);
  });

  test("de-dup keeps the highest score in a group", () => {
    resetQualityTables();
    db.saveProfile({ id: 'p', name: 'P' });
    db.saveCustomFormat({ id: 'a', name: 'x265', regex: 'x265', score: 10 });
    db.saveCustomFormat({ id: 'b', name: 'H.265 / HEVC', regex: 'x.?265|hevc', score: 40 });
    db.saveCustomFormat({ id: 'c', name: 'HDR', regex: 'HDR', score: 20 });
    for (const id of ['a', 'b', 'c']) db.addProfileFormat('p', id);
    const r = qualityEngine.calculateFormatScore('Show.S01E01.2160p.WEB-DL.HDR.x265', 'p');
    expect(r.score).toBe(60);
    expect(r.matchedFormats.sort()).toEqual(['H.265 / HEVC', 'HDR']);
    expect(formatGroupKey({ name: 'x265', regex: 'x265' })).toBe(formatGroupKey({ name: 'HEVC', regex: 'HEVC' }));
    expect(formatGroupKey({ name: 'VOSTFR', regex: 'vostfr' })).not.toBe(formatGroupKey({ name: 'ITA', regex: 'ita' }));
  });

  test("required/forbidden still apply per format, unaffected by de-dup", () => {
    resetQualityTables();
    db.saveProfile({ id: 'p', name: 'P' });
    db.saveCustomFormat({ id: 'hevc', name: 'HEVC', regex: 'HEVC', score: 50 });
    db.saveCustomFormat({ id: 'x265', name: 'x265', regex: 'x265', score: 50 });
    db.saveCustomFormat({ id: 'vostfr', name: 'VOSTFR', regex: 'vostfr', score: 0 });
    db.addProfileFormat('p', 'hevc', 'required');
    db.addProfileFormat('p', 'x265', 'bonus');
    db.addProfileFormat('p', 'vostfr', 'forbidden');
    const ok = qualityEngine.getReleaseScore('Show.S01E01.1080p.WEB-DL.x265', 'p');
    expect(ok.rejected).toBe(false);
    expect(ok.formatScore).toBe(50);
    const missing = qualityEngine.getReleaseScore('Show.S01E01.1080p.WEB-DL.x264', 'p');
    expect(missing.rejectCode).toBe('MISSING_REQUIRED_FORMAT');
    const forbidden = qualityEngine.getReleaseScore('[Team] Show - 01 VOSTFR 1080p x265', 'p');
    expect(forbidden.rejectCode).toBe('FORBIDDEN_FORMAT_MATCHED');
  });

  test("allow-list uses the real tier now", () => {
    resetQualityTables();
    db.saveProfile({ id: 'p', name: 'P' });
    db.addProfileQuality('p', 'q_webdl_1080p');
    expect(qualityEngine.getReleaseScore('Show.S01E01.1080p.WEB-DL.H.264', 'p').rejected).toBe(false);
    const rip = qualityEngine.getReleaseScore('Show.S01E01.1080p.WEBRip.x264', 'p');
    expect(rip.rejected).toBe(true);
    expect(rip.rejectCode).toBe('QUALITY_NOT_ALLOWED');
  });
});

describe("probed files vs source tiers", () => {
  const probed1080 = {
    video: { codec: 'h264', width: 1920, height: 1080, fps: 23.976, codedWidth: 1920, codedHeight: 1080, bitrate: null, averageBitrate: null, hdr: false },
    audio: [{ codec: 'eac3', channels: 6, sampleRate: 48000, bitrate: null, averageBitrate: null }],
    overallBitrate: 6_000_000,
    fileSize: 2_000_000_000,
  };

  test("a same-resolution release can't upgrade a probed file on source alone", () => {
    resetQualityTables();
    db.saveProfile({ id: 'p', name: 'P' });
    const s = qualityEngine.getReleaseScoreFromMedia(probed1080, 'p');
    expect(s.qualityName).toBe('1080p');
    expect(s.totalScore).toBe(35000); // assumes Remux-1080p for comparison
    expect(qualityEngine.shouldUpgradeWithMedia(probed1080, 'Show - S01E01.mkv', 'Show.S01E01.1080p.WEB-DL.H.264', 'p')).toBe(false);
    expect(qualityEngine.shouldUpgradeWithMedia(probed1080, 'Show - S01E01.mkv', 'Show.S01E01.2160p.WEB-DL.H.265', 'p')).toBe(true);
  });

  test("a known stored source lets a real source upgrade through", () => {
    resetQualityTables();
    db.saveProfile({ id: 'p', name: 'P' });
    const stored = 'Show.S01E01.1080p.WEBRip.x264-GRP';
    expect(qualityEngine.shouldUpgradeWithMedia(probed1080, 'Show - S01E01.mkv', 'Show.S01E01.1080p.WEB-DL.H.264', 'p', stored)).toBe(true);
    expect(qualityEngine.shouldUpgradeWithMedia(probed1080, 'Show - S01E01.mkv', 'Show.S01E01.1080p.HDTV.x264', 'p', stored)).toBe(false);
    // A stored title with no source (anime) keeps the assume-best rule.
    const anime = '[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv';
    expect(qualityEngine.shouldUpgradeWithMedia(probed1080, 'Show - S01E01.mkv', 'Show.S01E01.1080p.WEB-DL.H.264', 'p', anime)).toBe(false);
    const merged = mergeProbeWithRelease(qualityEngine.getReleaseScoreFromMedia(probed1080, 'p'), qualityEngine.getReleaseScore(stored, 'p'));
    expect(merged.qualityName).toBe('WEBRip-1080p');
    expect(merged.totalScore).toBe(32000);
  });
});

describe("testReleaseName (settings test box)", () => {
  test("full breakdown", () => {
    seedAnimeProfile();
    db.db.run("UPDATE quality_profiles SET cutoff_quality_id = 'q_webdl_1080p' WHERE id = 'anime'");
    const r = testReleaseName('[Team] Frieren - 01 VOSTFR 1080p WEBRip x265', 'anime');
    expect(r.resolution).toBe(1080);
    expect(r.source).toBe('WEBRip');
    expect(r.tier?.name).toBe('WEBRip-1080p');
    expect(r.tierVia).toBe('exact');
    expect(r.formatScore).toBe(0);
    expect(r.totalScore).toBe(32000);
    expect(r.allowed).toBe(true);
    expect(r.formats.filter(f => f.matched && f.deduped).length).toBe(4);
    expect(r.cutoff).toEqual({ name: 'WEBDL-1080p', rank: 33, met: false });
    const met = testReleaseName('Frieren.S01E01.1080p.BluRay.REMUX', 'anime');
    expect(met.cutoff?.met).toBe(true);
  });
});
