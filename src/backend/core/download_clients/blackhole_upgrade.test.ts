import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../db";
import { BlackholeClient } from "./blackhole";
import { isSafeReplaceArtifact } from "./safe_replace";

// Upgrade safety for the watch-folder importer:
//  - the old library file is only retired after the new one is in place AND
//    the DB points at it; a failure restores it (no more delete-then-move).
//  - a multi-episode file must beat EVERY covered episode's current file.
//
// Shared `db` singleton (same convention as blackhole_movie.test.ts): unique
// ids per run + explicit cleanup. The oracle is stubbed so no provider calls.
const RUN_ID = `bhup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let watchRoot = "";
let libraryRoot = "";
let showId = "";

beforeEach(() => {
  watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bhup-watch-"));
  libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bhup-lib-"));
  showId = `${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
  db.saveShow({
    uuid: showId,
    providerId: `p-${showId}`,
    type: "tmdb",
    title: "Upgrade Show",
    config: {},
    rootFolderPath: libraryRoot,
  });
});

afterEach(() => {
  try {
    db.removeShow(showId);
    db.db.run(`DELETE FROM processed_files WHERE original_path LIKE ?`, [`${watchRoot}%`]);
  } catch {}
  fs.rmSync(watchRoot, { recursive: true, force: true });
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

function makeClient(episodes: number[], proposedPath: string): BlackholeClient {
  const client = new BlackholeClient({
    downloadClient: { blackhole: { watchFolder: watchRoot } },
    defaultProvider: "tmdb",
    onCollision: "skip",
  } as any);
  client.attachFolderForManualOps();
  (client as any).oracle.resolveWithGrabHint = async () => ({
    show: { id: `p-${showId}`, provider: "tmdb", title: "Upgrade Show" },
    episodes: episodes.map((e) => ({ season: 1, episode: e, title: `Ep ${e}` })),
    proposedPath,
    usedHint: false,
  });
  return client;
}

/** Put an existing library file on disk + in the DB for the given episodes. */
function seedExisting(name: string, episodes: number[], content = "OLD"): string {
  const p = path.join(libraryRoot, "Season 01", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${content}-${RUN_ID}-${name}`);
  for (const e of episodes) {
    db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: e, title: `Ep ${e}`, filePath: p });
    db.recordEpisodeFile({ showId, season: 1, episode: e, filePath: p, originalName: name });
  }
  return p;
}

function drop(name: string): string {
  const p = path.join(watchRoot, name);
  fs.writeFileSync(p, `NEW-${RUN_ID}-${name}`);
  return name;
}

const epPath = (e: number) => db.getEpisode(showId, 1, e)?.file_path;
const artifacts = () => fs.readdirSync(path.join(libraryRoot, "Season 01")).filter(isSafeReplaceArtifact);

test("multi-episode file is NOT imported when it only beats one covered episode", async () => {
  const e1 = seedExisting("Upgrade.Show.S01E01.720p.HDTV.x264-A.mkv", [1]);
  const e2 = seedExisting("Upgrade.Show.S01E02.2160p.WEB-DL.x265-B.mkv", [2]);
  const name = drop("Upgrade.Show.S01E01E02.1080p.WEB-DL.x264-C.mkv");

  const client = makeClient([1, 2], "Season 01/Upgrade Show - S01E01-E02.mkv");
  await (client as any).handleFile(watchRoot, name);

  expect(fs.existsSync(e1)).toBe(true);
  expect(fs.existsSync(e2)).toBe(true);
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
  expect(epPath(1)).toBe(e1);
  expect(epPath(2)).toBe(e2);
}, 30_000);

test("multi-episode upgrade over every covered episode replaces both files and all episode rows", async () => {
  const e1 = seedExisting("Upgrade.Show.S01E01.720p.HDTV.x264-A.mkv", [1]);
  const e2 = seedExisting("Upgrade.Show.S01E02.720p.HDTV.x264-B.mkv", [2]);
  const name = drop("Upgrade.Show.S01E01E02.1080p.WEB-DL.x264-C.mkv");

  const client = makeClient([1, 2], "Season 01/Upgrade Show - S01E01-E02.mkv");
  await (client as any).handleFile(watchRoot, name);

  const dest = path.join(libraryRoot, "Season 01", "Upgrade Show - S01E01-E02.mkv");
  expect(fs.readFileSync(dest, "utf8")).toStartWith("NEW-");
  expect(fs.existsSync(e1)).toBe(false);
  expect(fs.existsSync(e2)).toBe(false);
  expect(epPath(1)).toBe(dest);
  expect(epPath(2)).toBe(dest);
  expect(db.getCurrentEpisodeFile(showId, 1, 1)?.file_path).toBe(dest);
  expect(db.getCurrentEpisodeFile(showId, 1, 2)?.file_path).toBe(dest);
  expect(artifacts()).toHaveLength(0);
}, 30_000);

test("an old file that also holds an episode outside the new file is kept", async () => {
  const e1 = seedExisting("Upgrade.Show.S01E01.720p.HDTV.x264-A.mkv", [1]);
  const e23 = seedExisting("Upgrade.Show.S01E02E03.720p.HDTV.x264-B.mkv", [2, 3]);
  const name = drop("Upgrade.Show.S01E01E02.1080p.WEB-DL.x264-C.mkv");

  const client = makeClient([1, 2], "Season 01/Upgrade Show - S01E01-E02.mkv");
  await (client as any).handleFile(watchRoot, name);

  const dest = path.join(libraryRoot, "Season 01", "Upgrade Show - S01E01-E02.mkv");
  expect(fs.existsSync(e1)).toBe(false);
  expect(fs.existsSync(e23)).toBe(true); // E03 still needs it
  expect(epPath(2)).toBe(dest);
  expect(epPath(3)).toBe(e23);
}, 30_000);

test("a DB failure after the move restores the old file and keeps the DB on it", async () => {
  const name0 = "Upgrade.Show.S01E01.720p.HDTV.x264-A.mkv";
  const proposed = "Season 01/Upgrade Show - S01E01.mkv";
  // Old file lives at the SAME path the upgrade targets: the old code deleted
  // it first, so any failure here used to lose the episode entirely.
  const oldPath = path.join(libraryRoot, proposed);
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, "OLD-CONTENT");
  db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: 1, title: "Ep 1", filePath: oldPath });
  db.recordEpisodeFile({ showId, season: 1, episode: 1, filePath: oldPath, originalName: name0 });
  const name = drop("Upgrade.Show.S01E01.1080p.WEB-DL.x264-C.mkv");

  const client = makeClient([1], proposed);
  const original = db.recordEpisodeFile.bind(db);
  (db as any).recordEpisodeFile = () => { throw new Error("SQLITE_FULL"); };
  try {
    await (client as any).handleFile(watchRoot, name);
  } finally {
    (db as any).recordEpisodeFile = original;
  }

  expect(fs.readFileSync(oldPath, "utf8")).toBe("OLD-CONTENT");
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
  expect(epPath(1)).toBe(oldPath);
  expect(db.getCurrentEpisodeFile(showId, 1, 1)?.original_name).toBe(name0);
  expect(artifacts()).toHaveLength(0);
}, 30_000);

test("a move failure leaves the old file in place", async () => {
  const proposed = "Season 01/Upgrade Show - S01E01.mkv";
  const oldPath = path.join(libraryRoot, proposed);
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, "OLD-CONTENT");
  db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: 1, title: "Ep 1", filePath: oldPath });
  db.recordEpisodeFile({ showId, season: 1, episode: 1, filePath: oldPath, originalName: "Upgrade.Show.S01E01.720p.HDTV.x264-A.mkv" });
  const name = drop("Upgrade.Show.S01E01.1080p.WEB-DL.x264-C.mkv");

  const client = makeClient([1], proposed);
  (client as any).beginReplace = async () => {
    throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
  };
  await (client as any).handleFile(watchRoot, name);

  expect(fs.readFileSync(oldPath, "utf8")).toBe("OLD-CONTENT");
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
  expect(epPath(1)).toBe(oldPath);
}, 30_000);
