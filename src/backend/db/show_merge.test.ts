import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "./index";
import { mergeShows } from "../core/show_merge";
import { detectOverlappingFolders, consolidateOverlappingFolders } from "../core/folder_dedup";
import { test, expect, afterAll, beforeEach } from "bun:test";

// Own temp dir (not a shared fixed path) so the suite works for any user.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-merge-db-"));
const db = new DatabaseManager(path.join(tmpDir, "folder-dedup-test.db"));
let tmpRoot = "";

afterAll(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeShow(title: string, i: number, seriesType = "standard") {
  const uuid = `show-${i}`;
  db.saveShow({
    uuid,
    providerId: `prov-${i}`,
    type: "tmdb",
    title,
    config: {},
    seriesType,
  });
  return db.getShow(uuid) as any;
}

function makeFolder(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-folder-dedup-"));
  db.saveShowProfile("lib-anime", "Anime", tmpRoot);
});

test("merge folds episodes and providers into target", async () => {
  const a = makeShow("Re: ZERO, Starting Life in Another World", 4, "anime");
  const b = makeShow("Re-ZERO -Starting Life in Another World-", 5, "anime");

  db.saveEpisode({ showId: a.id, seasonNumber: 1, episodeNumber: 1, title: "The End of the Beginning" });
  db.saveEpisode({ showId: b.id, seasonNumber: 1, episodeNumber: 2, title: "Reunion with the Witch" });

  db.addShowProvider(a.id, "tmdb", "12345", { title: a.title });
  db.addShowProvider(b.id, "tvdb", "99999", { title: b.title });

  const result = await mergeShows(db, a.id, b.id);
  expect(result.adoptedEpisodes.length).toBe(1);
  expect(result.movedFiles.length).toBe(0);

  const aEpisodes = db.listAllEpisodes(a.id);
  expect(aEpisodes.length).toBe(2);
  expect(db.getShow(b.id)).toBeNull();
});

test("detects overlapping folders that normalize to the same key", async () => {
  const show = makeShow("HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing", 1);
  makeShow("A Completely Different Show", 2);

  const f1 = makeFolder("HELL MODE - The Hardcore Gamer Dominates in Another World with Garbage Balancing");
  const f2 = makeFolder("HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing");
  makeFolder("A Completely Different Show");

  fs.writeFileSync(path.join(f1, "S01E01.mkv"), "a");
  fs.writeFileSync(path.join(f2, "S01E02.mkv"), "b");

  const groups = await detectOverlappingFolders(db);
  expect(groups.length).toBe(1);
  const group = groups[0]!;
  expect(group.folders.length).toBe(2);
  expect(group.canonicalFolder).toBe(f2);
  expect(group.wouldMove.length).toBe(1);
  expect(group.wouldMove[0]!.from).toBe(path.join(f1, "S01E01.mkv"));
  expect(group.wouldMove[0]!.to).toBe(path.join(f2, "S01E01.mkv"));
});

test("consolidation moves files into the canonical folder and removes the other", async () => {
  makeShow("HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing", 1);
  makeShow("A Completely Different Show", 2);

  const f1 = makeFolder("HELL MODE - The Hardcore Gamer Dominates in Another World with Garbage Balancing");
  const f2 = makeFolder("HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing");
  makeFolder("A Completely Different Show");

  fs.writeFileSync(path.join(f1, "S01E01.mkv"), "a");
  fs.writeFileSync(path.join(f1, "S01E02.mkv"), "b");

  const groups = await detectOverlappingFolders(db);
  const group = groups[0]!;
  const result = await consolidateOverlappingFolders(db, tmpRoot, group.key);

  expect(result.moved).toBe(2);
  expect(result.removedFolders).toEqual([f1]);
  expect(fs.existsSync(path.join(f2, "S01E01.mkv"))).toBe(true);
  expect(fs.existsSync(path.join(f2, "S01E02.mkv"))).toBe(true);
  expect(fs.existsSync(f1)).toBe(false);

  // After consolidation no groups remain.
  const remaining = await detectOverlappingFolders(db);
  expect(remaining.length).toBe(0);
});