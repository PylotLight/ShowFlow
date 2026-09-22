import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { BlackholeClient, isTorrentArtifact } from "./blackhole";

// Indexer grabs with no downloading client running write the release's magnet
// link into the blackhole output folder as `{infoHash}.magnet` — which
// defaults to the very folder this importer watches. The importer must treat
// those (.torrent/.magnet) as handoff artifacts, never as media: no hashing,
// no resolve attempts, no manual-import holds, no listing as importable.
const MAGNET = "c49b8e4ed83a3c3a0265cc6cc42bf5a5e56ccfa0.magnet";
const TORRENT = "some.release.2024.1080p.torrent";

let watchRoot = "";
let client: BlackholeClient | null = null;

function makeClient(): BlackholeClient {
  return new BlackholeClient({
    downloadClient: { blackhole: { watchFolder: watchRoot } },
    defaultProvider: "tmdb",
    onCollision: "skip",
  } as any);
}

beforeEach(() => {
  watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showflow-bh-artifact-"));
});

afterEach(() => {
  fs.rmSync(watchRoot, { recursive: true, force: true });
});

test("isTorrentArtifact matches .torrent/.magnet case-insensitively, nothing else", () => {
  expect(isTorrentArtifact(MAGNET)).toBe(true);
  expect(isTorrentArtifact(TORRENT)).toBe(true);
  expect(isTorrentArtifact("HASH.MAGNET")).toBe(true);
  expect(isTorrentArtifact("release.Torrent")).toBe(true);
  expect(isTorrentArtifact("Show.S01E01.1080p.mkv")).toBe(false);
  expect(isTorrentArtifact("magnet-link.txt")).toBe(false);
  expect(isTorrentArtifact("magnet")).toBe(false);
});

test("watch folder list/count ignore handoff artifacts but keep real media", async () => {
  fs.writeFileSync(path.join(watchRoot, MAGNET), "magnet:?xt=urn:btih:c49b8e4ed83a3c3a0265cc6cc42bf5a5e56ccfa0");
  fs.writeFileSync(path.join(watchRoot, TORRENT), "not-a-real-torrent");
  fs.writeFileSync(path.join(watchRoot, "Show.S01E01.1080p.mkv"), "x");

  client = makeClient();
  expect(client.attachFolderForManualOps()).toBe(true);

  const listed = await client.listWatchFolderFiles();
  expect(listed.map(e => e.filename)).toEqual(["Show.S01E01.1080p.mkv"]);
  expect(await client.countWatchFolderFiles()).toBe(1);
});

test("scan leaves artifacts alone: no hold, no delete, no import", async () => {
  const magnetPath = path.join(watchRoot, MAGNET);
  fs.writeFileSync(magnetPath, "magnet:?xt=urn:btih:c49b8e4ed83a3c3a0265cc6cc42bf5a5e56ccfa0");

  client = makeClient();
  expect(client.attachFolderForManualOps()).toBe(true);
  await client.scanExistingFiles(watchRoot, { silent: true });

  expect(fs.existsSync(magnetPath)).toBe(true);
  expect(client.isHeldForManual(magnetPath)).toBe(false);
  expect(client.getProcessingFiles()).toHaveLength(0);
});

test("force-import rejects handoff artifacts instead of moving them into the library", async () => {
  const magnetPath = path.join(watchRoot, MAGNET);
  fs.writeFileSync(magnetPath, "magnet:?xt=urn:btih:c49b8e4ed83a3c3a0265cc6cc42bf5a5e56ccfa0");

  client = makeClient();
  expect(client.attachFolderForManualOps()).toBe(true);
  const res = await client.forceImport(MAGNET);
  expect(res.ok).toBe(false);
  expect(res.message).toInclude("handoff artifact");

  // Still in the watch folder, untouched.
  expect(fs.existsSync(magnetPath)).toBe(true);
});
