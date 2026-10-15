import { test, expect, describe, afterEach } from "bun:test";
import { db } from "../db";
import { DatabaseManager } from "../db/index";
import { markReleaseFailed, failGrabsForRelease, advanceGrabsForRelease, dropBlocklisted, isBlocklisted } from "./release_failures";
import { TorrentHealthTracker } from "./download_clients/torbox_health";
import { runRssSyncCycle, type RssSource } from "./rss_sync";
import type { Indexer, IndexerResult } from "../providers/indexers/types";
import type { ReleaseScore } from "./quality_engine";

const HOUR = 3_600_000;
const RUN_ID = `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const HASH = "abcdef0123456789abcdef0123456789abcdef01";
const created: string[] = [];

function seedShow(): string {
  const id = `${RUN_ID}-${created.length}`;
  created.push(id);
  const past = new Date(Date.now() - 48 * HOUR).toISOString();
  db.saveShow({ uuid: id, providerId: `p-${id}`, type: "tmdb", title: "Fail Show", config: {} });
  for (const n of [1, 2]) {
    db.saveEpisode({ showId: id, seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDate: past });
    db.updateEpisodeAirWindow(id, 1, n, { expectedReleaseAt: past });
    db.setTracked(id, 1, n, true);
  }
  return id;
}

afterEach(() => {
  for (const id of created.splice(0)) {
    try {
      db.db.run(`DELETE FROM release_blocklist WHERE show_id = ?`, [id]);
      db.db.run(`DELETE FROM grabbed_releases WHERE show_id = ?`, [id]);
      db.removeShow(id);
    } catch {}
  }
});

const lastGrabId = (showId: string, ep: number) =>
  (db.db.query(`SELECT id FROM grabbed_releases WHERE show_id = ? AND episode_number = ? ORDER BY id DESC LIMIT 1`).get(showId, ep) as { id: number }).id;

const dueKeys = (showId: string) => {
  const now = new Date().toISOString();
  const cooldown = new Date(Date.now() - 12 * HOUR).toISOString();
  return db.listEpisodesDueForGrab(now, cooldown, 500)
    .filter((r) => r.show_id === showId)
    .map((r) => r.episode_number)
    .sort();
};

describe("markReleaseFailed", () => {
  test("fails the grab + its multi-episode siblings, blocklists, and frees the 12h cooldown", () => {
    const showId = seedShow();
    const title = "Fail.Show.S01E01E02.1080p.WEB-DL.x264-GRP";
    db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: title, indexerName: "Idx", infoHash: `magnet:?xt=urn:btih:${HASH.toUpperCase()}` });
    db.recordGrabbedRelease({ showId, season: 1, episode: 2, releaseTitle: title, indexerName: "Idx", infoHash: HASH });
    // In-flight: both held by the cooldown, and a search miss backs E1 off.
    db.recordEpisodeSearchMiss(showId, 1, 1);
    expect(dueKeys(showId)).toEqual([]);

    const res = markReleaseFailed({ grabId: lastGrabId(showId, 1), reason: "dead torrent", source: "torbox" });
    expect(res!.failedGrabIds).toHaveLength(2);
    expect(res!.blocklistId).not.toBeNull();

    const g = db.getGrab(lastGrabId(showId, 2))!;
    expect(g.status).toBe("failed");
    expect(g.failure_reason).toContain("dead torrent");
    expect(g.failed_at).not.toBeNull();
    expect(g.info_hash).toBe(HASH);

    // Cooldown + backoff reset -> both episodes are due again immediately.
    expect(dueKeys(showId)).toEqual([1, 2]);

    const bl = db.listBlocklist(50).find((b) => b.show_id === showId)!;
    expect(bl.release_title).toBe(title);
    expect(JSON.parse(bl.episode_numbers!)).toEqual([1, 2]);
    expect(bl.info_hash).toBe(HASH);
  });

  test("isBlocklisted matches by hash (any title) or normalized title, per show", () => {
    const showId = seedShow();
    db.addToBlocklist({ showId, season: 1, episodes: [1], releaseTitle: "Fail Show S01E01 720p HDTV", infoHash: HASH });
    expect(isBlocklisted(showId, { title: "fail.show.s01e01.720p.hdtv" })).toBe(true);
    expect(isBlocklisted(showId, { title: "Renamed Upload", infoHash: HASH.toUpperCase() })).toBe(true);
    expect(isBlocklisted(showId, { title: "x", magnetUrl: `magnet:?xt=urn:btih:${HASH}&dn=x` })).toBe(true);
    expect(isBlocklisted(showId, { title: "Fail Show S01E01 1080p WEB" })).toBe(false);
    expect(isBlocklisted("another-show", { title: "Fail Show S01E01 720p HDTV" })).toBe(false);
    // Adding the same release again merges instead of duplicating.
    db.addToBlocklist({ showId, season: 1, episodes: [2], releaseTitle: "Fail Show S01E01 720p HDTV" });
    const rows = db.listBlocklist(50).filter((b) => b.show_id === showId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.episode_numbers!)).toEqual([1, 2]);
  });

  test("dropBlocklisted removes only blocklisted candidates", () => {
    const showId = seedShow();
    db.addToBlocklist({ showId, releaseTitle: "Fail Show S01E01 1080p WEB-DL-BAD" });
    const out = dropBlocklisted(showId, [
      { title: "Fail.Show.S01E01.1080p.WEB-DL-BAD" },
      { title: "Fail.Show.S01E01.1080p.WEB-DL-GOOD" },
    ], { season: 1, episode: 1 });
    expect(out.map((r) => r.title)).toEqual(["Fail.Show.S01E01.1080p.WEB-DL-GOOD"]);
  });

  test("TorBox waiter funnel: advance then fail by title, never touching imported grabs", () => {
    const showId = seedShow();
    const title = "Fail Show S01E01 2160p WEB-DL";
    db.recordGrabbedRelease({ showId, season: 1, episode: 1, releaseTitle: title });
    advanceGrabsForRelease({ title }, "downloading");
    expect(db.getGrab(lastGrabId(showId, 1))!.status).toBe("downloading");
    // status never moves backwards
    db.markGrabStatus(lastGrabId(showId, 1), "grabbed");
    expect(db.getGrab(lastGrabId(showId, 1))!.status).toBe("downloading");

    expect(failGrabsForRelease({ title }, "stalled for 15m")).toBe(1);
    expect(db.getGrab(lastGrabId(showId, 1))!.status).toBe("failed");
    expect(isBlocklisted(showId, { title })).toBe(true);
    // A failed grab is never resurrected by a late status update.
    db.markGrabStatus(lastGrabId(showId, 1), "completed");
    expect(db.getGrab(lastGrabId(showId, 1))!.status).toBe("failed");

    // imported grabs are not "open" -> a late failure report leaves them alone
    db.recordGrabbedRelease({ showId, season: 1, episode: 2, releaseTitle: "Fail Show S01E02 1080p" });
    db.markGrabStatus(lastGrabId(showId, 2), "imported");
    expect(failGrabsForRelease({ title: "Fail Show S01E02 1080p" }, "late")).toBe(0);
    expect(db.getGrab(lastGrabId(showId, 2))!.status).toBe("imported");
  });
});

describe("TorrentHealthTracker", () => {
  const M = 60_000;
  test("error/failed states fail immediately", () => {
    expect(new TorrentHealthTracker().observe("error", 10, 0).failed).toBe(true);
    expect(new TorrentHealthTracker().observe("failed (no peers)", null, 0).failed).toBe(true);
  });
  test("stalled only fails after the threshold, and a recovery resets it", () => {
    const t = new TorrentHealthTracker(15 * M, 999 * M);
    expect(t.observe("stalledDL", 5, 0).failed).toBe(false);
    expect(t.observe("stalledDL", 5, 10 * M).failed).toBe(false);
    expect(t.observe("downloading", 6, 11 * M).failed).toBe(false);
    expect(t.observe("stalledDL", 6, 12 * M).failed).toBe(false);
    expect(t.observe("stalledDL", 6, 26 * M).failed).toBe(false);
    const v = t.observe("stalledDL", 6, 27 * M);
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toContain("stalled");
  });
  test("no progress beyond the threshold is dead; progress keeps it alive", () => {
    const t = new TorrentHealthTracker(999 * M, 90 * M);
    expect(t.observe("metaDL", 0, 0).failed).toBe(false);
    expect(t.observe("downloading", 1, 80 * M).failed).toBe(false);
    expect(t.observe("downloading", 1, 169 * M).failed).toBe(false);
    const v = t.observe("downloading", 1, 171 * M);
    expect(v.failed).toBe(true);
    if (v.failed) expect(v.reason).toContain("dead");
  });
});

describe("RSS candidate filter", () => {
  function rel(title: string, guid: string): IndexerResult {
    return {
      guid, indexerId: 1, indexerName: "t", title, seeders: 0, leechers: 0, grabs: 0, size: 0,
      publishDate: new Date().toISOString(), ageHours: 0, infoUrl: "", downloadUrl: "", magnetUrl: "", infoHash: "",
      protocol: "torrent", categories: [], indexerFlags: [], isPack: false,
    };
  }
  const fakeScore = (title: string): ReleaseScore =>
    ({ totalScore: /1080p/.test(title) ? 2000 : 1000, rejected: false } as unknown as ReleaseScore);

  test("skips a blocklisted release and re-searches an episode whose grab failed", async () => {
    const mem = new DatabaseManager(":memory:");
    const past = new Date(Date.now() - 48 * HOUR).toISOString();
    mem.saveShow({ uuid: "s", providerId: "p", type: "tmdb", title: "Due Show", config: {} });
    mem.saveEpisode({ showId: "s", seasonNumber: 1, episodeNumber: 1, title: "E1", airDate: past });
    mem.updateEpisodeAirWindow("s", 1, 1, { expectedReleaseAt: past });
    mem.setTracked("s", 1, 1, true);
    // A failed grab inside the 12h window must NOT hold the episode.
    mem.recordGrabbedRelease({ showId: "s", season: 1, episode: 1, releaseTitle: "Due Show S01E01 1080p WEB-DL-BAD" });
    const gid = (mem.db.query(`SELECT id FROM grabbed_releases`).get() as { id: number }).id;
    mem.markGrabFailed(gid, "dead");
    mem.addToBlocklist({ showId: "s", season: 1, episodes: [1], releaseTitle: "Due Show S01E01 1080p WEB-DL-BAD" });

    const indexer: Indexer = {
      name: "Prowlarr", search: async () => [], grab: async () => true,
      validate: async () => ({ ok: true }), listIndexers: async () => [],
      fetchRecent: async () => [{ key: "prowlarr:1", name: "t", results: [
        rel("Due Show S01E01 1080p WEB-DL-BAD", "g1"),
        rel("Due Show S01E01 720p HDTV-OK", "g2"),
      ] }],
    };
    const source: RssSource = { id: "prowlarr", indexer };
    const grabbed: string[] = [];
    const res = await runRssSyncCycle({} as any, null, {
      db: mem, sources: [source], score: fakeScore,
      grab: async (r: any) => { grabbed.push(r.title); return { success: true, message: "ok" }; },
    });
    expect(res.matchedEpisodes).toBe(1);
    expect(grabbed).toEqual(["Due Show S01E01 720p HDTV-OK"]);
    mem.close();
  });
});
