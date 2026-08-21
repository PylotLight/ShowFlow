import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./index";
import { LibraryScanner } from "../core/library_scanner";
import { test, expect, beforeEach, afterEach } from "bun:test";

// The scanner operates on the shared singleton `db`, so this test writes into
// it with unique IDs and cleans up afterwards (never reload()s the singleton,
// which would swap the DB file out from under other test files running in the
// same process).
const RUN_ID = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
let tmpRoot = "";

afterEach(() => {
  try {
    // Raw SQL for the lookup — drizzle has no getTable() helper, and a throw
    // here would silently leak rows into the shared singleton DB (which then
    // hijacks normalized-title matches on the next run).
    const shows = db.db.query(`SELECT id FROM shows WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const s of shows) db.removeShow(s.id);
    const libs = db.db.query(`SELECT id FROM library_types WHERE id LIKE ?`).all(`${RUN_ID}%`) as { id: string }[];
    for (const l of libs) db.removeLibraryType(l.id);
  } catch {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-scanner-"));
});

test("library-wide scan maps a variant-titled file via normalized title matching", async () => {
  const uuid = `${RUN_ID}-variant`;
  db.saveLibraryType({ id: `${RUN_ID}-lib`, name: `${RUN_ID} Anime`, rootFolderPath: tmpRoot });
  db.saveShow({
    uuid,
    providerId: `${RUN_ID}-prov`,
    type: "tmdb",
    title: "Re: ZERO, Starting Life in Another World",
    config: {},
    seriesType: "anime",
    libraryTypeId: `${RUN_ID}-lib`,
  });
  db.addShowProvider(uuid, "tmdb", `${RUN_ID}-12345`, { title: "Re: ZERO, Starting Life in Another World" });
  db.saveEpisode({ showId: uuid, seasonNumber: 4, episodeNumber: 12, title: "From Now On" });

  // The on-disk folder + filename use a DASH variant of the title (as if
  // renamed by Sonarr / a manual edit) — the raw getShowByName LIKE misses it.
  const folder = path.join(tmpRoot, "Re - ZERO, Starting Life in Another World", "Season 4");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "Re - ZERO, Starting Life in Another World - S04E12 - From Now On HDTV-1080p.mkv");
  fs.writeFileSync(file, "data");

  // getShowByName (raw LIKE) alone cannot find the show for the parsed title.
  const raw = db.getShowByName("Re - ZERO, Starting Life in Another World");
  expect(raw.length).toBe(0);

  const scanner = new LibraryScanner({} as any);
  await scanner.scan();

  const ep = db.getEpisode(uuid, 4, 12);
  expect(ep?.file_path).toBe(file);
  // file exists on disk => not cleared as stale
  expect(fs.existsSync(file)).toBe(true);
});
