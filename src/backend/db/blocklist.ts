import type { DatabaseManager } from './index';
import { normalizeReleaseTitle, normalizeInfoHash } from './grabs';

export interface BlocklistRow {
  id: number;
  show_id: string;
  season_number: number | null;
  episode_numbers: string | null;
  release_title: string;
  normalized_title: string;
  info_hash: string | null;
  indexer_name: string | null;
  reason: string | null;
  created_at: string;
}

export interface BlocklistListRow extends BlocklistRow {
  show_title: string | null;
}

/**
 * Blocklist a release for a show. Idempotent per (show, hash-or-title): a
 * second failure of the same release merges its episode numbers into the
 * existing row instead of adding a duplicate.
 */
export function addToBlocklist(self: DatabaseManager, input: {
  showId: string;
  season?: number | null;
  episodes?: number[] | null;
  releaseTitle: string;
  infoHash?: string | null;
  indexerName?: string | null;
  reason?: string | null;
}): number | null {
  const normalized = normalizeReleaseTitle(input.releaseTitle);
  if (!normalized) return null;
  const hash = normalizeInfoHash(input.infoHash);
  const existing = self.db.query(`
    SELECT * FROM release_blocklist
    WHERE show_id = ? AND ((? IS NOT NULL AND info_hash = ?) OR normalized_title = ?)
    LIMIT 1
  `).get(input.showId, hash, hash, normalized) as BlocklistRow | null;
  if (existing) {
    const eps = new Set<number>(existing.episode_numbers ? JSON.parse(existing.episode_numbers) : []);
    for (const e of input.episodes ?? []) eps.add(e);
    self.db.query(`
      UPDATE release_blocklist SET episode_numbers = ?, info_hash = COALESCE(info_hash, ?), reason = COALESCE(?, reason)
      WHERE id = ?
    `).run(eps.size ? JSON.stringify([...eps].sort((a, b) => a - b)) : null, hash, input.reason ?? null, existing.id);
    return existing.id;
  }
  const res = self.db.query(`
    INSERT INTO release_blocklist
      (show_id, season_number, episode_numbers, release_title, normalized_title, info_hash, indexer_name, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.showId,
    input.season ?? null,
    input.episodes?.length ? JSON.stringify([...new Set(input.episodes)].sort((a, b) => a - b)) : null,
    input.releaseTitle,
    normalized,
    hash,
    input.indexerName ?? null,
    input.reason ? input.reason.slice(0, 500) : null,
    new Date().toISOString(),
  );
  return Number(res.lastInsertRowid);
}

/** True when `release` (by info hash or normalized title) is blocklisted for the show. */
export function isBlocklisted(
  self: DatabaseManager,
  showId: string,
  release: { title: string; infoHash?: string | null; magnetUrl?: string | null },
): boolean {
  const hash = normalizeInfoHash(release.infoHash) ?? normalizeInfoHash(release.magnetUrl);
  const normalized = normalizeReleaseTitle(release.title);
  const row = self.db.query(`
    SELECT 1 FROM release_blocklist
    WHERE show_id = ? AND ((? IS NOT NULL AND info_hash = ?) OR normalized_title = ?)
    LIMIT 1
  `).get(showId, hash, hash, normalized);
  return !!row;
}

export function listBlocklist(self: DatabaseManager, limit = 200): BlocklistListRow[] {
  return self.db.query(`
    SELECT b.*, s.title AS show_title
    FROM release_blocklist b LEFT JOIN shows s ON s.id = b.show_id
    ORDER BY b.id DESC LIMIT ?
  `).all(Math.max(1, Math.min(1000, limit))) as BlocklistListRow[];
}

export function removeFromBlocklist(self: DatabaseManager, id: number): boolean {
  return self.db.query(`DELETE FROM release_blocklist WHERE id = ?`).run(id).changes > 0;
}

export function clearBlocklist(self: DatabaseManager): number {
  return self.db.query(`DELETE FROM release_blocklist`).run().changes;
}
