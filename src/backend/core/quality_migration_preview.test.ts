import { test, expect } from "bun:test";
import { db } from "../db";
import seedManifest from "../db/seed/manifest.json";
import { buildMigrationPreview } from "./quality_migration_preview";
import { convertLegacyProfiles } from "../db/quality_model";

const RUN = `pv_${Date.now().toString(36)}`;

test("migration preview: old vs new on grabbed releases + library files", () => {
  for (const q of seedManifest.qualities) db.saveQuality(q);
  // The user's legacy Anime profile: 5 HEVC spellings (+50) and VOSTFR (-50), no cutoff.
  const profileId = `${RUN}_anime`;
  db.saveProfile({ id: profileId, name: "Anime (legacy)" });
  const formats = [["x265", "x265"], ["HEVC", "HEVC"], ["H265", "H265"], ["265", "265"], ["H.265", "H\\.265"]] as const;
  formats.forEach(([name, regex], i) => {
    db.saveCustomFormat({ id: `${RUN}_f${i}`, name, regex, score: 50 });
    db.addProfileFormat(profileId, `${RUN}_f${i}`);
  });
  db.saveCustomFormat({ id: `${RUN}_vost`, name: "VOSTFR", regex: "vostfr", score: -50 });
  db.addProfileFormat(profileId, `${RUN}_vost`);
  convertLegacyProfiles(db);

  const showId = `${RUN}_show`;
  db.saveShow({ uuid: showId, providerId: `p-${showId}`, type: "tmdb", title: `Frieren ${RUN}`, config: {} });
  db.db.run(`UPDATE shows SET profile = ?, library_type_id = NULL WHERE id = ?`, [profileId, showId]);
  db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: 1, title: "E1", filePath: "/lib/Frieren - S01E01.mkv" });
  db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: "[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv" });
  db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: "[Team] Frieren - 01 VOSTFR 1080p WEBRip x265" });
  db.recordEpisodeFile({ showId, season: 1, episode: 1, filePath: "/lib/Frieren - S01E01.mkv", originalName: "[Team] Frieren - 01 VOSTFR 1080p WEBRip x265" });

  const p = buildMigrationPreview(db, { limit: 50 });
  const mine = p.releases.filter(r => r.show === `Frieren ${RUN}`);
  expect(mine).toHaveLength(2);
  const vost = mine.find(r => r.title.includes("VOSTFR"))!;
  expect(vost.old).toMatchObject({ decision: "accept", quality: "WEBRip-1080p", total: 32000 });
  expect(vost.new).toMatchObject({ decision: "accept", quality: "WEBRip-1080p", total: 33000 + 100 - 300 });
  expect(p.winnerFlips).toContainEqual({
    show: `Frieren ${RUN}`, episode: "S01E01",
    oldWinner: "[Team] Frieren - 01 VOSTFR 1080p WEBRip x265",
    newWinner: "[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv",
  });
  const file = p.files.find(f => f.show === `Frieren ${RUN}`)!;
  expect(file.old.cutoff).toBe("off");
  expect(file.new.cutoff).toBe("off");
  expect(file.importReplaces).toEqual({ old: true, new: false });
  const prof = p.profiles.find(x => x.id === profileId)!;
  expect(prof.note).toContain("merged 5 formats");
  expect(prof.upgradesEnabled).toBe(false);

  db.removeShow(showId);
  db.removeProfile(profileId);
});
