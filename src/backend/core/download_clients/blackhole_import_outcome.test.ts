import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../db";
import { BlackholeClient, hashFileForDedupe } from "./blackhole";
import { isSafeReplaceArtifact } from "./safe_replace";
import { getImportReason } from "../manual_import_reasons";
import { saveProfileModel } from "../../db/quality_model";

// 1. A duplicate skip is sticky: held (keyed by path+size+mtime) so the
//    3-minute safety rescan doesn't re-hash the file forever, and a changed
//    file under the same name is re-evaluated.
// 2. A force import that fails partway reports ok:false with the real error,
//    logs no import, records no file row, and leaves the library file intact.
//
// Shared `db` singleton (same convention as blackhole_upgrade.test.ts):
// unique ids per run + explicit cleanup. The oracle is stubbed.
const RUN_ID = `bhio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PROFILE = `${RUN_ID}-up`;

let watchRoot = "";
let libraryRoot = "";
let showId = "";
const restores: Array<() => void> = [];
// Audit log is shared across runs/files: only count events from this test.
let eventBaseline = 0;

function patch<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K]) {
  const orig = obj[key];
  (obj as any)[key] = impl;
  restores.push(() => { (obj as any)[key] = orig; });
}

beforeEach(() => {
  eventBaseline = (db.listRecentEvents(1)[0] as any)?.id ?? 0;
  watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bhio-watch-"));
  libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bhio-lib-"));
  showId = `${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
  db.saveShow({
    uuid: showId,
    providerId: `p-${showId}`,
    type: "tmdb",
    title: "Outcome Show",
    config: {},
    rootFolderPath: libraryRoot,
  });
  saveProfileModel(db, { id: PROFILE, name: "Upgrades on", upgradesEnabled: true });
  db.db.run(`UPDATE shows SET profile = ?, library_type_id = NULL WHERE id = ?`, [PROFILE, showId]);
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  try {
    const shows = db.db.query(`SELECT id FROM shows WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const s of shows) db.removeShow(s.id);
    db.db.run(`DELETE FROM processed_files WHERE original_path LIKE ?`, [`${watchRoot}%`]);
    db.db.run(`DELETE FROM quality_profiles WHERE id = ?`, [PROFILE]);
    db.removeSetting("blackhole.manual_holds");
    db.removeSetting("blackhole.manual_hold_reasons");
  } catch {}
  fs.rmSync(watchRoot, { recursive: true, force: true });
  fs.rmSync(libraryRoot, { recursive: true, force: true });
});

function makeClient(episodes: number[] = [1], proposedPath = "Season 01/Outcome Show - S01E01.mkv"): BlackholeClient {
  const client = new BlackholeClient({
    downloadClient: { blackhole: { watchFolder: watchRoot } },
    defaultProvider: "tmdb",
    onCollision: "skip",
  } as any);
  client.attachFolderForManualOps();
  (client as any).oracle.resolveWithGrabHint = async () => ({
    show: { id: `p-${showId}`, provider: "tmdb", title: "Outcome Show" },
    episodes: episodes.map((e) => ({ season: 1, episode: e, title: `Ep ${e}` })),
    proposedPath,
    usedHint: false,
  });
  return client;
}

function seedExisting(name: string, episode = 1): string {
  const p = path.join(libraryRoot, "Season 01", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `OLD-${RUN_ID}-${name}`);
  db.saveEpisode({ showId, seasonNumber: 1, episodeNumber: episode, title: `Ep ${episode}`, filePath: p });
  db.recordEpisodeFile({ showId, season: 1, episode, filePath: p, originalName: name });
  return p;
}

function drop(name: string, content = `NEW-${RUN_ID}-${name}`): string {
  fs.writeFileSync(path.join(watchRoot, name), content);
  return name;
}

const importEventsFor = (name: string) =>
  db.listRecentEvents(200).filter((e: any) => e.id > eventBaseline &&
    (e.event_type === "grab" || e.event_type === "manual-import") && String(e.message).includes(name));

const artifactsUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...artifactsUnder(p));
    else if (isSafeReplaceArtifact(p)) out.push(p);
  }
  return out;
};

// ---- 1. sticky duplicate skips ---------------------------------------------

async function seedDuplicate(name: string): Promise<{ client: BlackholeClient; fullPath: string; hashes: () => number; enqueued: string[] }> {
  drop(name);
  const fullPath = path.join(watchRoot, name);
  const hash = await hashFileForDedupe(fullPath);
  db.logProcessedFile(hash, path.join(watchRoot, `earlier-${name}`), path.join(libraryRoot, "earlier.mkv"));
  const client = makeClient();
  let hashCount = 0;
  const realHash = (client as any).hashFile.bind(client);
  (client as any).hashFile = async (p: string) => { hashCount++; return realHash(p); };
  const enqueued: string[] = [];
  // Record what the rescan would queue without actually processing it.
  (client as any).enqueue = (_folder: string, filename: string) => { enqueued.push(filename); };
  return { client, fullPath, hashes: () => hashCount, enqueued };
}

test("a duplicate skip is held so the safety rescan doesn't re-hash it", async () => {
  const name = "Outcome.Show.S01E01.1080p.WEB-DL.x264-DUP.mkv";
  const { client, fullPath, hashes, enqueued } = await seedDuplicate(name);

  const imported = await (client as any).handleFile(watchRoot, name);
  expect(imported).toBe(false);
  expect(hashes()).toBe(1);
  expect(client.isHeldForManual(fullPath)).toBe(true);
  expect(getImportReason(fullPath, fs.statSync(fullPath).size)?.code).toBe("DUPLICATE");
  expect(fs.existsSync(fullPath)).toBe(true);

  // Several safety rescans later: never re-queued, never re-hashed.
  for (let i = 0; i < 3; i++) await client.scanExistingFiles(watchRoot, { silent: true });
  expect(enqueued).toEqual([]);
  expect(hashes()).toBe(1);

  // Still listed on Manual Import with its Duplicate reason.
  const listed = await client.listWatchFolderFiles();
  const row = listed.find((r) => r.filename === name) as any;
  expect(row?.held).toBe(true);
  expect(row?.reason?.code ?? getImportReason(fullPath)?.code).toBe("DUPLICATE");
}, 30_000);

test("a held file whose size changes is re-evaluated", async () => {
  const name = "Outcome.Show.S01E01.1080p.WEB-DL.x264-CHG.mkv";
  const { client, fullPath, enqueued } = await seedDuplicate(name);
  await (client as any).handleFile(watchRoot, name);
  expect(client.isHeldForManual(fullPath)).toBe(true);

  fs.appendFileSync(fullPath, "-a-different-file-now");
  await client.scanExistingFiles(watchRoot, { silent: true });
  expect(enqueued).toEqual([name]);
  expect(client.isHeldForManual(fullPath)).toBe(false);
  expect(getImportReason(fullPath)).toBeNull();
}, 30_000);

test("a held file whose mtime changes (same size) is re-evaluated", async () => {
  const name = "Outcome.Show.S01E01.1080p.WEB-DL.x264-MT.mkv";
  const { client, fullPath } = await seedDuplicate(name);
  await (client as any).handleFile(watchRoot, name);
  expect(client.isHeldForManual(fullPath)).toBe(true);

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(fullPath, later, later);
  expect(client.isHeldForManual(fullPath)).toBe(false);
}, 30_000);

test("legacy path-only holds stay sticky", () => {
  const name = drop("Outcome.Show.S01E02.720p.HDTV.x264-OLD.mkv");
  const fullPath = path.join(watchRoot, name);
  db.setSetting("blackhole.manual_holds", [fullPath]);
  const client = makeClient();
  expect(client.isHeldForManual(fullPath)).toBe(true);
  fs.appendFileSync(fullPath, "x");
  expect(client.isHeldForManual(fullPath)).toBe(true);
  client.releaseManualHold(fullPath);
  expect(client.isHeldForManual(fullPath)).toBe(false);
});

// ---- 2. force-import failures propagate -----------------------------------

test("force import that fails at the DB step reports the error and keeps the library file", async () => {
  const existing = seedExisting("Outcome.Show.S01E01.720p.HDTV.x264-A.mkv");
  const name = drop("Outcome.Show.S01E01.1080p.WEB-DL.x264-C.mkv");
  const fullPath = path.join(watchRoot, name);
  // Also a previously-processed hash: a failed force import must not drop it.
  const hash = await hashFileForDedupe(fullPath);
  db.logProcessedFile(hash, path.join(watchRoot, `earlier-${name}`), path.join(libraryRoot, "earlier.mkv"));

  patch(db as any, "recordEpisodeFile", () => { throw new Error("disk I/O error (simulated)"); });

  const client = makeClient();
  const res = await client.forceImport(name);

  expect(res.ok).toBe(false);
  expect(res.message).toContain("disk I/O error (simulated)");
  expect(res.message).not.toContain("Imported");
  // Library file untouched, incoming file back in the watch folder.
  expect(fs.readFileSync(existing, "utf8")).toStartWith("OLD-");
  expect(fs.existsSync(fullPath)).toBe(true);
  expect(fs.existsSync(path.join(libraryRoot, "Season 01", "Outcome Show - S01E01.mkv"))).toBe(false);
  expect(artifactsUnder(libraryRoot)).toHaveLength(0);
  // DB still points at the old file; no import event logged.
  expect(db.getEpisode(showId, 1, 1)?.file_path).toBe(existing);
  expect(db.getCurrentEpisodeFile(showId, 1, 1)?.file_path).toBe(existing);
  expect(importEventsFor(name)).toHaveLength(0);
  expect(db.isProcessed(hash)).toBe(true);
}, 30_000);

test("force import onto an occupied destination (collision=skip) is a failure, not 'Imported'", async () => {
  // An unrelated file already at the destination, not tracked for E01.
  const dest = path.join(libraryRoot, "Season 01", "Outcome Show - S01E01.mkv");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `SQUATTER-${RUN_ID}`);
  const name = drop("Outcome.Show.S01E01.1080p.WEB-DL.x264-D.mkv");

  const client = makeClient();
  const res = await client.forceImport(name);

  expect(res.ok).toBe(false);
  expect(res.message).toContain("already exists");
  expect(fs.readFileSync(dest, "utf8")).toStartWith("SQUATTER-");
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
  expect(importEventsFor(name)).toHaveLength(0);
}, 30_000);

test("force import that fails to resolve metadata reports the real error", async () => {
  const name = drop("Totally.Unknown.Thing.S01E01.1080p.WEB-DL.x264-E.mkv");
  const client = makeClient();
  (client as any).oracle.resolveWithGrabHint = async () => null;
  (client as any).oracle.getDiagnostics = () => ({ parsed: { show: "Totally Unknown Thing" }, providerAttempts: [] });

  const res = await client.forceImport(name);
  expect(res.ok).toBe(false);
  expect(res.message).toContain("Could not find show");
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
}, 30_000);

test("movie force import that fails after placing the file restores the existing movie", async () => {
  const movieId = `${RUN_ID}-movie`;
  db.saveShow({
    uuid: movieId,
    providerId: `m-${RUN_ID}-1`,
    type: "tmdb",
    title: "Thor",
    year: 2011,
    config: {},
    seriesType: "movie",
    rootFolderPath: libraryRoot,
  });
  const existing = path.join(libraryRoot, "Thor (2011)", "Thor (2011).mkv");
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, `OLD-MOVIE-${RUN_ID}`);
  db.recordMovieFile({ showId: movieId, filePath: existing, originalName: "Thor.2011.720p.BluRay.x264-OLD.mkv" });

  const name = drop("Thor.2011.1080p.BluRay.x264-NEW.mkv");
  // Fails AFTER the file is placed but before the DB write — this used to sit
  // outside the rollback and strand the old movie as a hidden backup.
  patch(db as any, "findMostRecentGrabForShow", () => { throw new Error("grab lookup exploded (simulated)"); });

  const client = makeClient();
  const res = await client.forceImport(name);

  expect(res.ok).toBe(false);
  expect(res.message).toContain("grab lookup exploded (simulated)");
  expect(fs.readFileSync(existing, "utf8")).toStartWith("OLD-MOVIE-");
  expect(fs.existsSync(path.join(watchRoot, name))).toBe(true);
  expect(artifactsUnder(libraryRoot)).toHaveLength(0);
  expect(db.getMovieFile(movieId)?.original_name).toBe("Thor.2011.720p.BluRay.x264-OLD.mkv");
  expect(importEventsFor(name)).toHaveLength(0);
}, 30_000);

test("a successful force import over an existing file still reports Imported and logs once", async () => {
  const existing = seedExisting("Outcome.Show.S01E01.1080p.WEB-DL.x264-A.mkv");
  const name = drop("Outcome.Show.S01E01.720p.HDTV.x264-F.mkv");

  const client = makeClient();
  const res = await client.forceImport(name);

  expect(res.ok).toBe(true);
  const dest = path.join(libraryRoot, "Season 01", "Outcome Show - S01E01.mkv");
  expect(fs.readFileSync(dest, "utf8")).toStartWith("NEW-");
  expect(fs.existsSync(existing)).toBe(false);
  expect(db.getEpisode(showId, 1, 1)?.file_path).toBe(dest);
  expect(importEventsFor(name).filter((e: any) => e.event_type === "manual-import")).toHaveLength(1);
}, 30_000);
