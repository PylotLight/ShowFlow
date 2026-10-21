import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { db } from "../db";
import { saveProfileModel } from "../db/quality_model";
import { BlackholeClient, hashFileForDedupe } from "./download_clients/blackhole";
import {
  audioFromName,
  describeSide,
  diffSides,
  upgradeReason,
  unresolvedCode,
  videoCodecFromName,
  formatBytes,
  _clearProbeCacheForTests,
} from "./manual_import_explain";
import {
  recordImportReason,
  getImportReason,
  clearImportReason,
  pruneImportReasons,
  clearAllImportReasons,
  MAX_ENTRIES,
} from "./manual_import_reasons";
import { qualityEngine, type ReleaseScore, type UpgradeExplanation } from "./quality_engine";

// ---- pure helpers -----------------------------------------------------------

const score = (over: Partial<ReleaseScore>): ReleaseScore => ({
  rank: 0, formatScore: 0, totalScore: 0, rejected: false, matchedTags: [], ...over,
});

const expl = (over: Partial<UpgradeExplanation>): UpgradeExplanation => ({
  isUpgrade: false,
  verdict: "worse",
  existing: score({ rank: 37, totalScore: 37000, qualityName: "WEBDL-1080p", resolution: 1080, source: "webdl" }),
  newcomer: score({ rank: 36, totalScore: 36000, qualityName: "WEBRip-1080p", resolution: 1080, source: "webrip" }),
  existingBasis: "probe",
  upgradesAllowed: true,
  profileName: "HD",
  ...over,
});

describe("name parsing", () => {
  test("video codec from release name", () => {
    expect(videoCodecFromName("Show.S01E01.1080p.WEB-DL.x265-GRP.mkv")).toBe("HEVC");
    expect(videoCodecFromName("Show.S01E01.1080p.WEB-DL.H.264-GRP.mkv")).toBe("H.264");
    expect(videoCodecFromName("Show.S01E01.1080p.WEB-DL.AV1-GRP.mkv")).toBe("AV1");
    expect(videoCodecFromName("Show S01E01")).toBeNull();
  });

  test("audio from release name", () => {
    expect(audioFromName("Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv")).toBe("DD+ 5.1");
    expect(audioFromName("Show.S01E01.2160p.BluRay.TrueHD.7.1.Atmos-GRP.mkv")).toBe("TrueHD 7.1 Atmos");
    expect(audioFromName("Show.S01E01.1080p.WEB.AAC2.0.x264-GRP.mkv")).toBe("AAC 2.0");
    expect(audioFromName("Show.S01E01.1080p.WEB.x264-GRP.mkv")).toBeNull();
  });

  test("bytes", () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MB");
    expect(formatBytes(null)).toBeNull();
  });

  test("unresolved code from the resolver message", () => {
    expect(unresolvedCode("Could not parse show name or episode numbers from filename")).toBe("PARSE_FAILED");
    expect(unresolvedCode('Could not match "Foo" against existing library shows')).toBe("UNMATCHED");
    expect(unresolvedCode(undefined)).toBe("UNMATCHED");
  });
});

describe("side-by-side diff", () => {
  test("verdicts are from the incoming file's point of view", () => {
    const incoming = describeSide({
      filename: "Show.S01E01.1080p.WEBRip.DDP5.1.x264-AAA.mkv",
      sizeBytes: 1_000_000_000,
      score: score({ rank: 36, totalScore: 36010, formatScore: 10, qualityName: "WEBRip-1080p", resolution: 1080, source: "webrip" }),
    });
    const existing = describeSide({
      filename: "Show - S01E01.mkv",
      releaseName: "Show.S01E01.2160p.WEB-DL.DV.DDP5.1.Atmos.H.265-BBB",
      sizeBytes: 4_000_000_000,
      score: score({ rank: 47, totalScore: 47020, formatScore: 20, qualityName: "WEBDL-2160p", resolution: 2160, source: "webdl" }),
    });
    expect(existing.releaseGroup).toBe("BBB");
    expect(existing.hdr).toBe("Dolby Vision");
    expect(existing.videoCodec).toBe("HEVC");
    expect(incoming.container).toBe("MKV");

    const d = Object.fromEntries(diffSides(incoming, existing).map((x) => [x.field, x]));
    expect(d.score!.verdict).toBe("worse");
    expect(d.score!.note).toBe("-11,010");
    expect(d.quality!.verdict).toBe("worse");
    expect(d.resolution!.verdict).toBe("worse");
    expect(d.source!.verdict).toBe("worse");
    expect(d.hdr!.verdict).toBe("worse");
    expect(d.size!.verdict).toBe("smaller");
    expect(d.size!.note).toStartWith("-");
    expect(d.videoCodec!.verdict).toBe("different");
    expect(d.group!.verdict).toBe("different");
    expect(d.container!.verdict).toBe("same");
  });

  test("a probe wins over the name for the technical facts", () => {
    const side = describeSide({
      filename: "Show - S01E01.mkv",
      releaseName: "Show.S01E01.720p.HDTV.x264-GRP",
      probe: {
        video: { codec: "hevc", width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080, fps: 24, hdr: true, bitrate: null, averageBitrate: null },
        audio: [{ codec: "eac3", channels: 6, sampleRate: 48000, bitrate: null, averageBitrate: null }],
        overallBitrate: null,
        fileSize: 123,
      },
      score: score({ rank: 30, totalScore: 30000, resolution: 1080 }),
    });
    expect(side.resolution).toBe(1080);
    expect(side.videoCodec).toBe("HEVC");
    expect(side.hdr).toBe("HDR");
    expect(side.audio).toBe("DD+ 5.1");
    expect(side.sizeBytes).toBe(123);
    expect(side.detailsFrom).toBe("probe");
  });
});

describe("upgradeReason", () => {
  test("lower score -> NOT_AN_UPGRADE with both scores and what differs", () => {
    const r = upgradeReason(expl({}), { name: "WEBDL-2160p", met: false }, "Show - S01E01.mkv");
    expect(r.code).toBe("NOT_AN_UPGRADE");
    expect(r.detail).toContain("36,000 vs 37,000");
    expect(r.detail).toContain("WEBRip-1080p");
    expect(r.detail).toContain("lower score");
  });

  test("equal score + cutoff met -> CUTOFF_MET", () => {
    const e = expl({
      verdict: "equal",
      newcomer: score({ rank: 37, totalScore: 37000, qualityName: "WEBDL-1080p" }),
    });
    const r = upgradeReason(e, { name: "WEBDL-1080p", met: true }, "x.mkv");
    expect(r.code).toBe("CUTOFF_MET");
    expect(r.detail).toContain("meets the profile cutoff (WEBDL-1080p)");
    expect(r.detail).toContain("same score");
    expect(r.detail).toContain("same preferred-terms score");
  });

  test("same quality, lower term score is named as the cause", () => {
    const e = expl({
      existing: score({ rank: 37, totalScore: 37050, formatScore: 50, qualityName: "WEBDL-1080p" }),
      newcomer: score({ rank: 37, totalScore: 37000, formatScore: 0, qualityName: "WEBDL-1080p" }),
    });
    expect(upgradeReason(e, null, "x.mkv").detail).toContain("preferred-terms score is 0 vs 50");
  });

  test("upgrades off / rejected / sample / upgrade", () => {
    expect(upgradeReason(expl({ verdict: "upgrades_off", upgradesAllowed: false }), null, "x.mkv").code).toBe("UPGRADES_OFF");
    const rej = upgradeReason(expl({ verdict: "rejected", newcomer: score({ rejected: true, rejectReason: "Never term matched: CAM", totalScore: -1 }) }), null, "x.mkv");
    expect(rej.code).toBe("REJECTED_BY_PROFILE");
    expect(rej.detail).toContain("Never term matched: CAM");
    expect(upgradeReason(expl({ verdict: "sample" }), null, "x.mkv").code).toBe("SAMPLE");
    expect(upgradeReason(expl({ verdict: "upgrade", isUpgrade: true }), null, "x.mkv").code).toBe("UPGRADE_WAITING");
  });

  test("explainUpgrade agrees with shouldUpgrade (same decision, now with reasons)", () => {
    const cases: Array<[string, string]> = [
      ["Show.S01E01.720p.HDTV.x264-A.mkv", "Show.S01E01.1080p.WEB-DL.x264-B.mkv"],
      ["Show.S01E01.2160p.WEB-DL.x265-A.mkv", "Show.S01E01.1080p.WEB-DL.x264-B.mkv"],
      ["Show.S01E01.1080p.WEB-DL.x264-A.mkv", "Show.S01E01.1080p.WEB-DL.x264-B.mkv"],
      ["Show.S01E01.1080p.WEB-DL.x264-A.mkv", "Show.S01E01.1080p.WEB-DL.x264-B-sample.mkv"],
    ];
    for (const [a, b] of cases) {
      expect(qualityEngine.explainUpgrade(null, a, b, "standard").isUpgrade).toBe(qualityEngine.shouldUpgrade(a, b, "standard"));
    }
  });
});

// ---- recorded reason store --------------------------------------------------

describe("recorded reasons", () => {
  const P = `/tmp/mi-reasons-${Date.now()}`;
  afterEach(() => clearAllImportReasons());

  test("record, read back, size guard, clear", () => {
    recordImportReason(`${P}/a.mkv`, { code: "DUPLICATE", message: "dup", size: 10 });
    expect(getImportReason(`${P}/a.mkv`, 10)?.code).toBe("DUPLICATE");
    // a different file landed under the same name
    expect(getImportReason(`${P}/a.mkv`, 11)).toBeNull();
    clearImportReason(`${P}/a.mkv`);
    expect(getImportReason(`${P}/a.mkv`)).toBeNull();
  });

  test("prune drops files no longer in the watch folder", () => {
    recordImportReason(`${P}/a.mkv`, { code: "DUPLICATE", message: "a" });
    recordImportReason(`${P}/b.mkv`, { code: "DUPLICATE", message: "b" });
    pruneImportReasons(new Set([`${P}/b.mkv`]));
    expect(getImportReason(`${P}/a.mkv`)).toBeNull();
    expect(getImportReason(`${P}/b.mkv`)?.message).toBe("b");
  });

  test("bounded: oldest entries fall off", () => {
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      recordImportReason(`${P}/f${i}.mkv`, { code: "IMPORT_ERROR", message: String(i) });
    }
    expect(getImportReason(`${P}/f0.mkv`)).toBeNull();
    expect(getImportReason(`${P}/f1.mkv`)?.message).toBe("1");
    expect(getImportReason(`${P}/f${MAX_ENTRIES}.mkv`)?.message).toBe(String(MAX_ENTRIES));
  });
});

// ---- importer + list integration -------------------------------------------
// Same conventions as blackhole_upgrade.test.ts: shared db singleton, unique
// ids, stubbed oracle (no provider calls).

const RUN_ID = `miex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const UP = `${RUN_ID}-up`;
const OFF = `${RUN_ID}-off`;
const CUT = `${RUN_ID}-cut`;
let watchRoot = "";
let libraryRoot = "";
let showId = "";

describe("Manual Import explanations", () => {
  beforeEach(() => {
    watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-miex-watch-"));
    libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-miex-lib-"));
    showId = `${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
    db.saveShow({ uuid: showId, providerId: `p-${showId}`, type: "tmdb", title: "Explain Show", config: {}, rootFolderPath: libraryRoot });
    saveProfileModel(db, { id: UP, name: "Upgrades on", upgradesEnabled: true });
    saveProfileModel(db, { id: OFF, name: "No upgrades", upgradesEnabled: false });
    saveProfileModel(db, { id: CUT, name: "Until 1080p", upgradesEnabled: true, upgradeUntilResolution: 1080 });
    db.db.run(`UPDATE shows SET profile = ?, library_type_id = NULL WHERE id = ?`, [UP, showId]);
    clearAllImportReasons();
    _clearProbeCacheForTests();
  });

  afterEach(() => {
    try {
      db.removeShow(showId);
      db.db.run(`DELETE FROM processed_files WHERE original_path LIKE ?`, [`${watchRoot}%`]);
      db.db.run(`DELETE FROM quality_profiles WHERE id IN (?, ?, ?)`, [UP, OFF, CUT]);
    } catch {}
    clearAllImportReasons();
    fs.rmSync(watchRoot, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  });

  function makeClient(episodes: number[], proposedPath = "Season 01/Explain Show - S01E01.mkv"): BlackholeClient {
    const client = new BlackholeClient({
      downloadClient: { blackhole: { watchFolder: watchRoot } },
      defaultProvider: "tmdb",
      onCollision: "skip",
    } as any);
    client.attachFolderForManualOps();
    const show = { id: `p-${showId}`, provider: "tmdb", title: "Explain Show" };
    (client as any).oracle.resolveWithGrabHint = async () => ({
      show,
      episodes: episodes.map((e) => ({ season: 1, episode: e, title: `Ep ${e}` })),
      proposedPath,
      usedHint: false,
    });
    (client as any).oracle.resolveForList = async () => ({ show, season: 1, episodes });
    return client;
  }

  function seedExisting(name: string, episodes: number[], opts: { releaseTitle?: string; size?: number } = {}): string {
    const p = path.join(libraryRoot, "Season 01", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "X".repeat(opts.size ?? 64));
    for (const e of episodes) {
      db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: e, title: `Ep ${e}`, filePath: p });
      db.recordEpisodeFile({ showId, season: 1, episode: e, filePath: p, originalName: opts.releaseTitle ?? name, fileSize: opts.size ?? 64, releaseTitle: opts.releaseTitle ?? null });
    }
    return p;
  }

  function drop(name: string, size = 32): string {
    fs.writeFileSync(path.join(watchRoot, name), `${RUN_ID}`.padEnd(size, "N"));
    return name;
  }

  test("a declined downgrade records NOT_AN_UPGRADE with both scores, and the list explains it", async () => {
    const existingPath = seedExisting("Explain.Show.S01E01.2160p.WEB-DL.DDP5.1.H.265-BIG.mkv", [1], { size: 4096 });
    const name = drop("Explain.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-SML.mkv");
    const client = makeClient([1]);

    await (client as any).handleFile(watchRoot, name);
    expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);

    const rec = getImportReason(path.join(watchRoot, name));
    expect(rec?.code).toBe("NOT_AN_UPGRADE");
    expect(rec!.incomingScore!).toBeLessThan(rec!.existingScore!);
    // Recorded scores are exactly what the quality engine compares.
    const e = qualityEngine.explainUpgrade(null, path.basename(existingPath), name, UP);
    expect(rec!.incomingScore).toBe(e.newcomer.totalScore);

    const [row] = await client.listWatchFolderFiles();
    expect(row!.reason!.code).toBe("NOT_AN_UPGRADE");
    expect(row!.reason!.label).toBe("Not an upgrade");
    expect(row!.reason!.source).toBe("recorded");
    const c = row!.comparison!;
    expect(c.existing!.filename).toBe(path.basename(existingPath));
    expect(c.existing!.resolution).toBe(2160);
    expect(c.incoming.resolution).toBe(1080);
    expect(c.scoreDelta!).toBeLessThan(0);
    const diffs = Object.fromEntries(c.diffs.map((d) => [d.field, d.verdict]));
    expect(diffs.resolution).toBe("worse");
    expect(diffs.size).toBe("smaller");
    expect(diffs.group).toBe("different");
    expect(row!.forceImport!.action).toBe("replace");
    expect(row!.forceImport!.replaces).toEqual([path.basename(existingPath)]);
    expect(row!.forceImport!.summary).toContain("deleted once the new one is in place");
  }, 30_000);

  test("without a recorded reason the list re-derives the same decision", async () => {
    seedExisting("Explain.Show.S01E01.2160p.WEB-DL.H.265-BIG.mkv", [1]);
    drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-SML.mkv");
    const [row] = await makeClient([1]).listWatchFolderFiles();
    expect(row!.reason!.code).toBe("NOT_AN_UPGRADE");
    expect(row!.reason!.source).toBe("derived");
    expect(row!.reason!.detail).toContain("lower score");
    expect(row!.comparison!.verdict).toBe("worse");
  }, 30_000);

  test("an upgrade still sitting in the folder says so", async () => {
    seedExisting("Explain.Show.S01E01.720p.HDTV.x264-OLD.mkv", [1]);
    drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-NEW.mkv");
    const [row] = await makeClient([1]).listWatchFolderFiles();
    expect(row!.reason!.code).toBe("UPGRADE_WAITING");
    expect(row!.comparison!.scoreDelta!).toBeGreaterThan(0);
    const diffs = Object.fromEntries(row!.comparison!.diffs.map((d) => [d.field, d.verdict]));
    expect(diffs.resolution).toBe("better");
    expect(diffs.source).toBe("better");
  }, 30_000);

  test("upgrades off in the profile", async () => {
    db.db.run(`UPDATE shows SET profile = ? WHERE id = ?`, [OFF, showId]);
    seedExisting("Explain.Show.S01E01.720p.HDTV.x264-OLD.mkv", [1]);
    const name = drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-NEW.mkv");
    const client = makeClient([1]);
    await (client as any).handleFile(watchRoot, name);
    const [row] = await client.listWatchFolderFiles();
    expect(row!.reason!.code).toBe("UPGRADES_OFF");
    expect(row!.reason!.detail).toContain('"No upgrades"');
    expect(row!.comparison!.upgradesAllowed).toBe(false);
  }, 30_000);

  test("existing file already at the cutoff", async () => {
    db.db.run(`UPDATE shows SET profile = ? WHERE id = ?`, [CUT, showId]);
    seedExisting("Explain.Show.S01E01.1080p.WEB-DL.H.264-A.mkv", [1]);
    const name = drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-B.mkv");
    const client = makeClient([1]);
    await (client as any).handleFile(watchRoot, name);
    const [row] = await client.listWatchFolderFiles();
    expect(row!.reason!.code).toBe("CUTOFF_MET");
    expect(row!.comparison!.cutoff).toEqual({ name: "1080p", met: true });
  }, 30_000);

  test("duplicate content hash is recorded as DUPLICATE", async () => {
    const name = drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-DUP.mkv");
    const full = path.join(watchRoot, name);
    db.logProcessedFile(await hashFileForDedupe(full), full, "/somewhere/else.mkv");
    const client = makeClient([1]);
    await (client as any).handleFile(watchRoot, name);
    expect(fs.existsSync(full)).toBe(true);
    const [row] = await client.listWatchFolderFiles();
    expect(row!.reason!.code).toBe("DUPLICATE");
    expect(row!.reason!.label).toBe("Duplicate");
  }, 30_000);

  test("multi-episode: blocked episode is named and Force Import keeps a file holding other episodes", async () => {
    seedExisting("Explain.Show.S01E01.720p.HDTV.x264-A.mkv", [1]);
    const e23 = seedExisting("Explain.Show.S01E02E03.2160p.WEB-DL.x265-B.mkv", [2, 3]);
    const name = drop("Explain.Show.S01E01E02.1080p.WEB-DL.x264-C.mkv");
    const client = makeClient([1, 2], "Season 01/Explain Show - S01E01-E02.mkv");
    await (client as any).handleFile(watchRoot, name);
    const rec = getImportReason(path.join(watchRoot, name));
    expect(rec?.code).toBe("NOT_AN_UPGRADE");
    expect(rec?.message).toContain("Blocked by S01E02");

    const [row] = await client.listWatchFolderFiles();
    expect(row!.comparison!.existing!.filename).toBe(path.basename(e23));
    expect(row!.comparison!.otherExisting).toEqual(["Explain.Show.S01E01.720p.HDTV.x264-A.mkv"]);
    expect(row!.forceImport!.replaces).toEqual(["Explain.Show.S01E01.720p.HDTV.x264-A.mkv"]);
    expect(row!.forceImport!.keeps).toEqual([path.basename(e23)]);
  }, 30_000);

  test("a new episode with nothing in the library is Ready", async () => {
    drop("Explain.Show.S01E05.1080p.WEB-DL.H.264-NEW.mkv");
    const [row] = await makeClient([5]).listWatchFolderFiles();
    expect(row!.reason!.code).toBe("NEW_WAITING");
    expect(row!.comparison!.existing).toBeNull();
    expect(row!.forceImport!.action).toBe("add");
  }, 30_000);

  test("unresolved files carry an Unmatched reason", async () => {
    drop("random_noise_file.mkv");
    const client = makeClient([1]);
    (client as any).oracle.resolveForList = async () => null;
    (client as any).oracle.getDiagnostics = () => ({ parsed: { show: "Nope Show" }, providerAttempts: [] });
    const [row] = await client.listWatchFolderFiles();
    expect(row!.resolved).toBe(false);
    expect(row!.reason!.code).toBe("UNMATCHED");
    expect(row!.reason!.label).toBe("Unmatched");
  }, 30_000);

  test("a successful import clears the recorded reason", async () => {
    seedExisting("Explain.Show.S01E01.720p.HDTV.x264-OLD.mkv", [1]);
    const name = drop("Explain.Show.S01E01.1080p.WEB-DL.H.264-NEW.mkv");
    const full = path.join(watchRoot, name);
    recordImportReason(full, { code: "COLLISION", message: "old" });
    await (makeClient([1]) as any).handleFile(watchRoot, name);
    expect(fs.existsSync(full)).toBe(false);
    expect(getImportReason(full)).toBeNull();
  }, 30_000);
});
