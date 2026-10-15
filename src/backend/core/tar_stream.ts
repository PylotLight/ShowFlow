// Streaming tar(.gz) extractor for release tarballs. Lets the app unpack
// showflow-<sha>.tar.gz *while it downloads* (gunzip + write overlap the
// network instead of running after it), so the supervisor can install from
// the already-extracted dir via /admin/install instead of buffering the whole
// tarball into memory and gunzipping it again in /admin/install-archive.
//
// Deliberately tiny: handles what `tar -czf` (GNU or ustar) emits for our
// release layout — regular files, directories, GNU long names ('L') and pax
// path records ('x'). Anything else (symlinks, devices) is skipped, and any
// path that would escape the destination dir is rejected.

import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const BLOCK = 512;

export interface ExtractedEntry {
  path: string;
  size: number;
  /** sha256 of the file's bytes (only for files listed in `hashFiles`). */
  sha256?: string;
}

export interface TarExtractor {
  /** Feed raw (already-decompressed) tar bytes. Awaiting gives backpressure. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finish; throws if the archive was truncated. Returns the files written. */
  end(): Promise<ExtractedEntry[]>;
}

function readString(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  const max = off + len;
  while (end < max && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(off, end));
}

function readOctal(buf: Uint8Array, off: number, len: number): number {
  // base-256 (GNU) for sizes > 8GB — never in our tarballs, refuse loudly.
  if (buf[off]! & 0x80) throw new Error("tar: base-256 size fields are not supported");
  const s = readString(buf, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  if (!Number.isFinite(n) || n < 0) throw new Error(`tar: bad octal field "${s}"`);
  return n;
}

function isZeroBlock(buf: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1); // drop trailing \n
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Resolves `name` under `root`, or null when it would escape it. */
export function safeJoin(root: string, name: string): string | null {
  const clean = name.replace(/^\.\/+/, "");
  if (!clean || clean.startsWith("/") || clean.includes("\0")) return null;
  const base = resolve(root);
  const full = resolve(base, clean);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Create an extractor writing into `destDir`. `hashFiles` lists entry paths
 * (e.g. "showflow") whose sha256 should be computed on the fly.
 */
export function createTarExtractor(destDir: string, opts: { hashFiles?: string[] } = {}): TarExtractor {
  const hashSet = new Set(opts.hashFiles ?? []);
  const entries: ExtractedEntry[] = [];

  // Pending bytes not yet consumed (always < one block between calls when
  // inside a file body we stream through directly).
  let pending = new Uint8Array(0);
  let state: "header" | "body" | "meta" | "done" = "header";
  let remaining = 0; // bytes left in current entry body
  let padding = 0; // zero padding after the body
  let sink: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  let hasher: Bun.CryptoHasher | null = null;
  let current: ExtractedEntry | null = null;
  let metaKind: "L" | "x" | null = null;
  let metaBuf: Uint8Array[] = [];
  let nextName: string | null = null;
  let zeroBlocks = 0;

  async function openEntry(name: string, type: string, size: number): Promise<void> {
    const path = name.replace(/^\.\/+/, "");
    if (type === "5") {
      const dir = safeJoin(destDir, path);
      if (!dir) throw new Error(`tar: refusing unsafe path "${name}"`);
      await mkdir(dir, { recursive: true });
      state = "header";
      return;
    }
    if (type === "0" || type === "\0" || type === "" || type === "7") {
      const file = safeJoin(destDir, path);
      if (!file) throw new Error(`tar: refusing unsafe path "${name}"`);
      await mkdir(dirname(file), { recursive: true });
      sink = Bun.file(file).writer({ highWaterMark: 1 << 20 });
      hasher = hashSet.has(path) ? new Bun.CryptoHasher("sha256") : null;
      current = { path, size };
      remaining = size;
      padding = (BLOCK - (size % BLOCK)) % BLOCK;
      state = "body";
      if (size === 0) await closeEntry();
      return;
    }
    // Unsupported type (symlink, hardlink, device…): skip its body.
    sink = null;
    hasher = null;
    current = null;
    remaining = size;
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
    state = "body";
    if (size === 0) await closeEntry();
  }

  async function closeEntry(): Promise<void> {
    if (sink) await sink.end();
    if (current) {
      if (hasher) current.sha256 = hasher.digest("hex");
      entries.push(current);
    }
    sink = null;
    hasher = null;
    current = null;
    state = "header";
  }

  async function handleHeader(block: Uint8Array): Promise<void> {
    if (isZeroBlock(block)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) state = "done";
      return;
    }
    zeroBlocks = 0;
    // Checksum: sum of header bytes with the chksum field as spaces.
    const stored = readOctal(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== stored) throw new Error("tar: header checksum mismatch (corrupt archive)");

    const type = String.fromCharCode(block[156]!);
    const size = readOctal(block, 124, 12);
    let name = readString(block, 0, 100);
    const magic = readString(block, 257, 6);
    if (magic.startsWith("ustar")) {
      const prefix = readString(block, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (type === "L" || type === "x") {
      metaKind = type;
      metaBuf = [];
      remaining = size;
      padding = (BLOCK - (size % BLOCK)) % BLOCK;
      state = "meta";
      if (size === 0) finishMeta();
      return;
    }
    if (type === "g") {
      // global pax header — nothing we need; skip body
      await openEntry("", "g", size);
      return;
    }
    if (nextName) {
      name = nextName;
      nextName = null;
    }
    await openEntry(name, type, size);
  }

  function finishMeta(): void {
    const total = metaBuf.reduce((n, b) => n + b.byteLength, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const b of metaBuf) { data.set(b, o); o += b.byteLength; }
    if (metaKind === "L") nextName = readString(data, 0, data.length);
    else if (metaKind === "x") {
      const pax = parsePax(data);
      if (pax.path) nextName = pax.path;
    }
    metaKind = null;
    metaBuf = [];
    state = "header";
  }

  async function consume(chunk: Uint8Array): Promise<void> {
    let buf = pending.byteLength ? concat(pending, chunk) : chunk;
    let off = 0;
    while (off < buf.byteLength && state !== "done") {
      if (state === "body" || state === "meta") {
        if (remaining > 0) {
          const take = Math.min(remaining, buf.byteLength - off);
          const part = buf.subarray(off, off + take);
          if (state === "body") {
            if (sink) sink.write(part);
            hasher?.update(part);
          } else {
            metaBuf.push(part.slice());
          }
          remaining -= take;
          off += take;
          if (remaining > 0) break;
        }
        if (padding > 0) {
          const skip = Math.min(padding, buf.byteLength - off);
          padding -= skip;
          off += skip;
          if (padding > 0) break;
        }
        if (state === "body") await closeEntry();
        else finishMeta();
        continue;
      }
      // header: need a full block
      if (buf.byteLength - off < BLOCK) break;
      await handleHeader(buf.subarray(off, off + BLOCK));
      off += BLOCK;
    }
    pending = off < buf.byteLength && state !== "done" ? buf.slice(off) : new Uint8Array(0);
    if (sink) await (sink as any).flush?.();
  }

  return {
    write: consume,
    async end() {
      if (state === "body" || state === "meta") {
        try { if (sink) await sink.end(); } catch {}
        throw new Error("tar: archive truncated mid-entry");
      }
      if (pending.byteLength && !isZeroBlock(pad(pending))) throw new Error("tar: trailing garbage / truncated header");
      return entries;
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function pad(b: Uint8Array): Uint8Array {
  if (b.byteLength >= BLOCK) return b.subarray(0, BLOCK);
  const out = new Uint8Array(BLOCK);
  out.set(b);
  return out;
}

/**
 * gzip → tar extractor. Returns a writer for the *compressed* bytes; awaiting
 * write() applies backpressure so a slow disk throttles the download instead
 * of ballooning memory.
 */
export function createTarGzExtractor(destDir: string, opts: { hashFiles?: string[] } = {}): TarExtractor {
  const tar = createTarExtractor(destDir, opts);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let failure: unknown = null;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) await tar.write(value);
      }
    } catch (err) {
      failure = err;
      try { await reader.cancel(); } catch {}
    }
  })();
  return {
    async write(chunk) {
      if (failure) throw failure;
      await writer.write(chunk as Uint8Array<ArrayBuffer>);
    },
    async end() {
      if (!failure) {
        try { await writer.close(); } catch (err) { failure = failure ?? err; }
      }
      await pump;
      if (failure) throw failure;
      return tar.end();
    },
  };
}
