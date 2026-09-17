import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../db";
import { BlackholeClient } from "./blackhole";

// Watch-folder movie import end-to-end (#33): a bare film drop must resolve
// against the library *movie* entry and land in `Title (Year)/Title (Year).ext`
// — previously the release year parsed as an absolute episode number, the
// movie fast-path bailed out, and the file died in the episode-only oracle
// with "Could not find show Thor on any configured provider".
//
// Uses the shared `db` singleton (same convention as scanner_rename.test.ts):
// unique ids per run + explicit cleanup, never reload().
const RUN_ID = `bh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const FILM = "Thor.2011.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.7.1.Atmos.MULTI-RIFE.4.25v2-60fps-DirtyHippie.mkv";

let watchRoot = "";
let libraryRoot = "";
let client: BlackholeClient | null = null;

function makeClient(): BlackholeClient {
  return new BlackholeClient({
    downloadClient: { blackhole: { watchFolder: watchRoot } },
    defaultProvider: "tmdb",
    onCollision: "skip",
  } as any);
}

beforeEach(() => {
  watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bh-watch-"));
  libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bh-lib-"));
});

afterEach(() => {
  try {
    const shows = db.db.query(`SELECT id FROM shows WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const s of shows) db.removeShow(s.id);
    db.db.run(`DELETE FROM processed_files WHERE original_path LIKE ?`, [`${watchRoot}%`]);
  } catch {}
  fs.rmSync(watchRoot, { recursive: true, force: true });
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

function seedMovie(): string {
  const uuid = `${RUN_ID}-thor`;
  db.saveShow({
    uuid,
    providerId: `m-${RUN_ID}-10195`,
    type: "tmdb",
    title: "Thor",
    year: 2011,
    config: {},
    seriesType: "movie",
    rootFolderPath: libraryRoot,
  });
  return uuid;
}

test("watch-folder list labels a film drop as a resolved movie, not a season/episode", async () => {
  const uuid = seedMovie();
  fs.writeFileSync(path.join(watchRoot, FILM), `movie-${RUN_ID}`);

  client = makeClient();
  client.attachFolderForManualOps();
  const listed = await client.listWatchFolderFiles();

  expect(listed).toHaveLength(1);
  expect(listed[0]!.kind).toBe("movie");
  expect(listed[0]!.show).toBe("Thor");
  expect(listed[0]!.showId).toBe(uuid);
  expect(listed[0]!.resolved).toBe(true);
  // The S/E axis must be absent, or the manual page renders season pickers
  // for a file that has none.
  expect(listed[0]!.season).toBeUndefined();
  expect(listed[0]!.episodes).toBeUndefined();
});

test("auto import moves a bare film drop into Title (Year)/Title (Year).ext", async () => {
  const uuid = seedMovie();
  fs.writeFileSync(path.join(watchRoot, FILM), `movie-${RUN_ID}`);

  client = makeClient();
  client.attachFolderForManualOps();
  const res = await client.forceImport(FILM);
  expect(res.ok).toBe(true);

  const expected = path.join(libraryRoot, "Thor (2011)", "Thor (2011).mkv");
  expect(fs.existsSync(expected)).toBe(true);
  expect(fs.existsSync(path.join(watchRoot, FILM))).toBe(false);

  const movieFile = db.getMovieFile(uuid);
  expect(movieFile?.file_path).toBe(expected);
  expect(movieFile?.original_name).toBe(FILM);
}, 30_000);

test("manual import with an explicit movie pick uses the movie importer", async () => {
  const uuid = seedMovie();
  fs.writeFileSync(path.join(watchRoot, FILM), `movie-${RUN_ID}`);

  client = makeClient();
  client.attachFolderForManualOps();
  const res = await client.forceImport(FILM, uuid);
  expect(res.ok).toBe(true);

  expect(fs.existsSync(path.join(libraryRoot, "Thor (2011)", "Thor (2011).mkv"))).toBe(true);
  expect(db.getMovieFile(uuid)?.file_path).not.toBeNull();
  // Movies never create episode rows, whatever the filename's digits suggest.
  expect(db.listEpisodes(uuid, 0)).toHaveLength(0);
}, 30_000);

test("a film with no library entry is reported as a missing movie, not an unmatched show", async () => {
  fs.writeFileSync(path.join(watchRoot, `Unknown.Title.2099.1080p.x264-${RUN_ID}.mkv`), "x");

  client = makeClient();
  client.attachFolderForManualOps();
  const listed = await client.listWatchFolderFiles();

  expect(listed[0]!.resolved).toBe(false);
  expect(listed[0]!.error).toInclude("No library movie");
  expect(listed[0]!.error).toInclude("Unknown Title");
});
