import { test, expect } from "bun:test";
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
