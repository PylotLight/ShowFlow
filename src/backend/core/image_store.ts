/**
 * Content-addressed artwork store on disk.
 *
 * Poster/backdrop bytes used to live as blobs in show_artworks.data, which
 * made showflow.db (and every VACUUM INTO backup of it) mostly images. Now
 * each image is a file named by the sha1 of its bytes:
 *
 *   <imagesDir>/<first 2 hex>/<sha1>.<ext>
 *
 * show_artworks keeps the metadata plus image_hash / image_path / byte_size.
 * Same bytes => same file, so two rows sharing an image share one file, and
 * a file is only removed once no row references its hash any more.
 *
 * imagesDir: SHOWFLOW_IMAGES_DIR, else $SHOWFLOW_DATA_DIR/images, else an
 * `images/` dir next to the DB file (in the container the DB is
 * /data/showflow.db, so that's /data/images either way).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function resolveImagesDir(dbPath: string): string {
  if (process.env.SHOWFLOW_IMAGES_DIR) return resolve(process.env.SHOWFLOW_IMAGES_DIR);
  if (process.env.SHOWFLOW_DATA_DIR) return resolve(process.env.SHOWFLOW_DATA_DIR, 'images');
  if (dbPath === ':memory:' || dbPath === '') {
    // tests: a private throwaway dir per in-memory DB
    return mkdtempSync(join(tmpdir(), 'showflow-images-'));
  }
  return join(dirname(resolve(dbPath)), 'images');
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export function extForContentType(contentType: string | null | undefined): string {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return EXT_BY_TYPE[base] ?? 'bin';
}

export function hashImage(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Relative path (inside imagesDir) for a hash + content type. */
export function imageRelPath(hash: string, contentType: string | null | undefined): string {
  return `${hash.slice(0, 2)}/${hash}.${extForContentType(contentType)}`;
}

/** Only accept paths we generated — never let a DB value escape imagesDir. */
const REL_RE = /^[0-9a-f]{2}\/[0-9a-f]{40}\.[a-z0-9]{2,5}$/;

export function absImagePath(imagesDir: string, rel: string): string | null {
  if (!REL_RE.test(rel)) return null;
  return join(imagesDir, rel);
}

export interface StoredImage {
  hash: string;
  path: string;
  size: number;
}

/**
 * Write bytes to their content-addressed file (no-op when it already
 * exists). tmp + rename so a crash never leaves a half-written file under
 * the final name.
 */
export function writeImage(imagesDir: string, bytes: Uint8Array, contentType: string | null | undefined): StoredImage {
  const hash = hashImage(bytes);
  const rel = imageRelPath(hash, contentType);
  const abs = join(imagesDir, rel);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, abs);
  }
  return { hash, path: rel, size: bytes.byteLength };
}

export function readImage(imagesDir: string, rel: string): Uint8Array | null {
  const abs = absImagePath(imagesDir, rel);
  if (!abs) return null;
  try {
    return new Uint8Array(readFileSync(abs));
  } catch {
    return null;
  }
}

export function imageExists(imagesDir: string, rel: string): boolean {
  const abs = absImagePath(imagesDir, rel);
  return !!abs && existsSync(abs);
}

export function deleteImageFile(imagesDir: string, rel: string): boolean {
  const abs = absImagePath(imagesDir, rel);
  if (!abs) return false;
  try {
    unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every image file under imagesDir as relative paths (+ mtime), for the
 * orphan sweep. Leftover *.tmp files are included so the sweep can clear
 * them too.
 */
export function listImageFiles(imagesDir: string): { rel: string; mtimeMs: number; size: number }[] {
  const out: { rel: string; mtimeMs: number; size: number }[] = [];
  let shards: string[];
  try {
    shards = readdirSync(imagesDir);
  } catch {
    return out;
  }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let files: string[];
    try {
      files = readdirSync(join(imagesDir, shard));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const st = statSync(join(imagesDir, shard, f));
        if (st.isFile()) out.push({ rel: `${shard}/${f}`, mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return out;
}

/** Remove a file by relative path, including stray .tmp files (sweep only). */
export function unlinkRel(imagesDir: string, rel: string): boolean {
  if (!/^[0-9a-f]{2}\/[^/]+$/.test(rel)) return false;
  try {
    unlinkSync(join(imagesDir, rel));
    return true;
  } catch {
    return false;
  }
}
