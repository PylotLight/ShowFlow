import { test, expect } from "bun:test";
import { qualityEngine } from "./quality_engine";
import { db } from "../db";

test("QualityEngine Scoring", async () => {
  // Clear tables to ensure consistent tests
  db.db.run('DELETE FROM quality_definitions');
  db.db.run('DELETE FROM quality_profiles');
  db.db.run('DELETE FROM custom_formats');
  db.db.run('DELETE FROM profile_formats');

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
