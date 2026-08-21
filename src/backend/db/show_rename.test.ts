import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "./index";
import { test, expect, afterAll, beforeEach } from "bun:test";

// Own temp dir (not a shared fixed path) so the suite works for any user.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-rename-db-"));
const db = new DatabaseManager(path.join(tmpDir, "show-rename-test.db"));
let tmpRoot = "";

afterAll(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-rename-"));
  db.saveShowProfile("lib-anime", "Anime", tmpRoot);
});

test("renameShow updates title, indexes new name, keeps old name matchable", () => {
  const uuid = "show-rename-1";
  db.saveShow({
    uuid,
    providerId: "prov-1",
    type: "tmdb",
    title: "Re: ZERO, Starting Life in Another World",
    config: {},
    seriesType: "anime",
  });
  db.addShowProvider(uuid, "tmdb", "12345", { title: "Re: ZERO, Starting Life in Another World" });

  const result = db.renameShow(uuid, "Re - ZERO, Starting Life in Another World");
  expect(result.renamed).toBe(true);
  expect(result.oldTitle).toBe("Re: ZERO, Starting Life in Another World");
  expect(db.getShow(uuid)?.title).toBe("Re - ZERO, Starting Life in Another World");

  // New name resolves on the normalized index (library-wide scan path).
  const byNew = db.findShowsByNormalizedTitle("re zero starting life in another world");
  expect(byNew.length).toBeGreaterThan(0);
  expect(byNew[0]!.showId).toBe(uuid);

  // Old name still resolves too (canonical/alias rows kept).
  const byOld = db.findShowsByNormalizedTitle("re zero starting life in another world");
  expect(byOld.some(s => s.showId === uuid)).toBe(true);

  // Provider sync must NOT clobber a user rename.
  db.updateShowSyncData(uuid, "tmdb", {
    title: "Re: ZERO, Starting Life in Another World",
    year: 2016,
    originalTitle: "Re:ゼロから始める異世界生活",
  });
  expect(db.getShow(uuid)?.title).toBe("Re - ZERO, Starting Life in Another World");
});

test("renameShow is a no-op for an unchanged normalized title", () => {
  const uuid = "show-rename-2";
  db.saveShow({
    uuid,
    providerId: "prov-2",
    type: "tmdb",
    title: "Some Show",
    config: {},
  });
  const result = db.renameShow(uuid, "Some Show");
  expect(result.renamed).toBe(false);
  expect(result.reason).toBe("unchanged");
  expect(db.getShow(uuid)?.title).toBe("Some Show");
});
