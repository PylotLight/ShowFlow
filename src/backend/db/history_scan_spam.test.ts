import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, afterEach } from "bun:test";
import { DatabaseManager, db } from "./index";
import { LibraryScanner } from "../core/library_scanner";

// Activity > History used to list every episode_files row as an import, and
// the library scanner appended a fresh row for every file on every scan
// (it never stored file_size, so its "unchanged" fast-path never hit). These
// pin both halves of the fix.

function seedShow(d: DatabaseManager, id = "hs1") {
  d.saveShow({ uuid: id, providerId: `${id}-p`, type: "tmdb", title: "History Show", config: {} });
  d.saveEpisode({ showId: id, seasonNumber: 2, episodeNumber: 11, title: "Day 2" });
}

test("listHistory only lists real imports, not scan/sync re-records", () => {
  const d = new DatabaseManager(":memory:");
  seedShow(d);
  d.recordEpisodeFile({ showId: "hs1", season: 2, episode: 11, filePath: "/lib/a.mkv", originalName: "Real.Import.mkv", fileSize: 10 });
  d.recordEpisodeFile({ showId: "hs1", season: 2, episode: 11, filePath: "/lib/a.mkv", originalName: "a.mkv", fileSize: 10, origin: "scan" });
  d.recordEpisodeFile({ showId: "hs1", season: 2, episode: 11, filePath: "/lib/a.mkv", originalName: "a.mkv", fileSize: 10, origin: "sync" });

  const imports = d.listHistory({ kind: "import" }).items;
  expect(imports.map(i => i.message)).toEqual(["Imported Real.Import.mkv"]);
  // The live row (used by ShowDetail / upgrade compares) is still the latest.
  expect(d.getCurrentEpisodeFile("hs1", 2, 11)?.origin).toBe("sync");
  d.close();
});

test("migration 0012 reclassifies rescan rows as origin=scan, keeps real imports", () => {
  const d = new DatabaseManager(":memory:");
  seedShow(d);
  const rec = (filePath: string, fileSize: number | null) =>
    d.recordEpisodeFile({ showId: "hs1", season: 2, episode: 11, filePath, originalName: path.basename(filePath), fileSize });
  rec("/lib/old.mkv", 100);     // real import
  rec("/lib/old.mkv", null);    // scanner re-record (never stored size)
  rec("/lib/new.mkv", 200);     // real upgrade import
  rec("/lib/new.mkv", 200);     // same file re-recorded (dedup / rescan)

  const sql = fs.readFileSync(path.join(import.meta.dir, "migrations", "0012_episode_file_origin.sql"), "utf8");
  const update = sql.split("--> statement-breakpoint").find(s => s.includes("UPDATE"))!;
  d.db.run("UPDATE episode_files SET origin = 'import'");
  d.db.run(update);

  const rows = d.db.query("SELECT file_path, file_size, origin FROM episode_files ORDER BY id").all() as any[];
  expect(rows.map(r => r.origin)).toEqual(["import", "scan", "import", "scan"]);
  expect(d.listHistory({ kind: "import" }).items.length).toBe(2);
  d.close();
});

// ---- scanner idempotency (shared singleton db, same pattern as scanner_rename.test.ts)
const RUN_ID = `hspam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let tmpRoot = "";
afterEach(() => {
  try {
    const shows = db.db.query(`SELECT id FROM shows WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const s of shows) db.removeShow(s.id);
    const libs = db.db.query(`SELECT id FROM library_types WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const l of libs) db.removeLibraryType(l.id);
  } catch {}
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("re-scanning an unchanged library file never adds episode_files rows or History imports", async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-hspam-"));
  const uuid = `${RUN_ID}-show`;
  db.saveLibraryType({ id: `${RUN_ID}-lib`, name: `${RUN_ID} TV`, rootFolderPath: tmpRoot });
  db.saveShow({ uuid, providerId: `${RUN_ID}-prov`, type: "tmdb", title: "Twenty Four Spam", config: {}, libraryTypeId: `${RUN_ID}-lib` });
  db.saveEpisode({ showId: uuid, seasonNumber: 2, episodeNumber: 11, title: "Day 2" });
  const folder = path.join(tmpRoot, "Twenty Four Spam", "Season 2");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "Twenty Four Spam - S02E11 - Day 2 Bluray-1080p.mkv");
  fs.writeFileSync(file, "not really a video");
  const rows = () => db.db.query(
    `SELECT id, file_size, origin, is_current FROM episode_files WHERE show_id = ? AND season_number = 2 AND episode_number = 11 ORDER BY id`,
  ).all(uuid) as any[];

  const scanner = new LibraryScanner({} as any);
  await scanner.scan();
  expect(rows().length).toBe(1);
  expect(rows()[0].file_size).toBe(fs.statSync(file).size);
  expect(rows()[0].origin).toBe("scan");

  await scanner.scan();
  await scanner.scanShow(uuid);
  expect(rows().length).toBe(1);

  // Legacy row written by the old scanner (no size): the next scan fills it
  // in place instead of appending another "Imported …" row.
  db.db.run(`UPDATE episode_files SET file_size = NULL WHERE show_id = ?`, [uuid]);
  await scanner.scan();
  expect(rows().length).toBe(1);
  expect(rows()[0].file_size).toBe(fs.statSync(file).size);

  // A genuinely replaced file (different size at the same path) is a change.
  fs.writeFileSync(file, "a different, longer not-really-a-video");
  await scanner.scan();
  expect(rows().length).toBe(2);
  expect(rows().filter(r => r.is_current === 1).length).toBe(1);

  expect(db.listHistory({ kind: "import", showId: uuid }).items.length).toBe(0);
  expect(db.getEpisode(uuid, 2, 11)?.file_path).toBe(file);
});
