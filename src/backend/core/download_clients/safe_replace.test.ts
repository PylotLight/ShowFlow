import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { FileReplacement, defaultFsOps, isSafeReplaceArtifact } from "./safe_replace";

let watch = "";
let lib = "";

beforeEach(() => {
  watch = fs.mkdtempSync(path.join(os.tmpdir(), "sf-sr-watch-"));
  lib = fs.mkdtempSync(path.join(os.tmpdir(), "sf-sr-lib-"));
});
afterEach(() => {
  fs.rmSync(watch, { recursive: true, force: true });
  fs.rmSync(lib, { recursive: true, force: true });
});

const read = (p: string) => fs.readFileSync(p, "utf8");
const leftovers = (dir: string) => fs.readdirSync(dir).filter(isSafeReplaceArtifact);

function seed() {
  const src = path.join(watch, "Show.S01E01.2160p.mkv");
  const old = path.join(lib, "Show - S01E01.mkv");
  fs.writeFileSync(src, "NEW");
  fs.writeFileSync(old, "OLD");
  return { src, old };
}

describe("FileReplacement", () => {
  test("replaces a file at the same path; old kept until finalize", async () => {
    const { src, old } = seed();
    const r = await FileReplacement.begin({ src, dest: old, replace: [old] });
    expect(r).not.toBeNull();
    expect(read(old)).toBe("NEW");
    expect(fs.existsSync(src)).toBe(false);
    // backup still on disk before finalize
    expect(leftovers(lib)).toHaveLength(1);
    await r!.finalize();
    expect(leftovers(lib)).toHaveLength(0);
    expect(read(old)).toBe("NEW");
  });

  test("replaces a differently named old file", async () => {
    const { src, old } = seed();
    const dest = path.join(lib, "Show - S01E01 - 2160p.mkv");
    const r = await FileReplacement.begin({ src, dest, replace: [old] });
    await r!.finalize();
    expect(read(dest)).toBe("NEW");
    expect(fs.existsSync(old)).toBe(false);
    expect(r!.replacedPaths).toEqual([old]);
  });

  test("failure while placing restores the old file and the incoming file", async () => {
    const { src, old } = seed();
    let n = 0;
    const ops = {
      rename: async (a: string, b: string) => {
        n++;
        // 1 = stage, 2 = backup, 3 = place -> fail
        if (n === 3) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return defaultFsOps.rename(a, b);
      },
    };
    await expect(FileReplacement.begin({ src, dest: old, replace: [old], ops })).rejects.toThrow("disk full");
    expect(read(old)).toBe("OLD");
    expect(read(src)).toBe("NEW");
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("cross-device: copies + fsyncs, deletes source only on finalize", async () => {
    const { src, old } = seed();
    let synced = "";
    const ops = {
      rename: async (a: string, b: string) => {
        if (a === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        return defaultFsOps.rename(a, b);
      },
      fsync: async (p: string) => { synced = p; },
    };
    const r = await FileReplacement.begin({ src, dest: old, replace: [old], ops });
    expect(isSafeReplaceArtifact(synced)).toBe(true);
    expect(read(old)).toBe("NEW");
    expect(fs.existsSync(src)).toBe(true); // still there until finalize
    await r!.finalize();
    expect(fs.existsSync(src)).toBe(false);
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("cross-device copy dying mid-way leaves the old file untouched", async () => {
    const { src, old } = seed();
    const ops = {
      rename: async (a: string, b: string) => {
        if (a === src) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        return defaultFsOps.rename(a, b);
      },
      copyFile: async (a: string, b: string) => {
        fs.writeFileSync(b, "NE"); // partial
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      },
    };
    await expect(FileReplacement.begin({ src, dest: old, replace: [old], ops })).rejects.toThrow("I/O error");
    expect(read(old)).toBe("OLD");
    expect(read(src)).toBe("NEW");
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("rollback after placement (e.g. DB failure) restores everything", async () => {
    const { src, old } = seed();
    const dest = path.join(lib, "Show - S01E01 - 2160p.mkv");
    const r = await FileReplacement.begin({ src, dest, replace: [old] });
    await r!.rollback();
    expect(read(old)).toBe("OLD");
    expect(read(src)).toBe("NEW");
    expect(fs.existsSync(dest)).toBe(false);
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("a failed second backup restores the first", async () => {
    const { src, old } = seed();
    const old2 = path.join(lib, "Show - S01E02.mkv");
    fs.writeFileSync(old2, "OLD2");
    const ops = {
      rename: async (a: string, b: string) => {
        if (a === old2) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return defaultFsOps.rename(a, b);
      },
    };
    const dest = path.join(lib, "Show - S01E01-E02.mkv");
    await expect(FileReplacement.begin({ src, dest, replace: [old, old2], ops })).rejects.toThrow();
    expect(read(old)).toBe("OLD");
    expect(read(old2)).toBe("OLD2");
    expect(read(src)).toBe("NEW");
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("collision with an unrelated file + skip changes nothing", async () => {
    const { src, old } = seed();
    const dest = path.join(lib, "occupied.mkv");
    fs.writeFileSync(dest, "OTHER");
    const r = await FileReplacement.begin({ src, dest, replace: [old], onCollision: "skip" });
    expect(r).toBeNull();
    expect(read(dest)).toBe("OTHER");
    expect(read(old)).toBe("OLD");
    expect(read(src)).toBe("NEW");
    expect(leftovers(lib)).toHaveLength(0);
  });

  test("collision + version picks a free name", async () => {
    const { src } = seed();
    const dest = path.join(lib, "occupied.mkv");
    fs.writeFileSync(dest, "OTHER");
    const r = await FileReplacement.begin({ src, dest, onCollision: "version" });
    await r!.finalize();
    expect(r!.finalPath).toBe(path.join(lib, "occupied (1).mkv"));
    expect(read(dest)).toBe("OTHER");
  });
});
