import { DatabaseManager } from "./index";
import { detectDuplicateShows, mergeShows } from "../core/show_merge";
import { test, expect, afterAll } from "bun:test";

const db = new DatabaseManager("/tmp/opencode/merge-test.db");

afterAll(() => {
  db.close();
  require("node:fs").rmSync("/tmp/opencode/merge-test.db", { force: true });
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

test("detects identical normalized titles as duplicates", () => {
  const a = makeShow("HELL MODE - The Hardcore Gamer Dominates in Another World with Garbage Balancing", 1);
  const b = makeShow("HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing", 2);
  const c = makeShow("A Completely Different Show", 3);

  const groups = detectDuplicateShows(db);
  const high = groups.filter(g => g.confidence === "high");
  expect(high.length).toBe(1);
  const top = high[0]!;
  expect(top.shows.length).toBe(2);
  expect(top.shows.map(s => s.title).sort()).toEqual(
    [a.title, b.title].sort()
  );

  const ids = new Set(groups.flatMap(g => g.shows.map(s => s.id)));
  expect(ids.has(c.id)).toBe(false);
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
