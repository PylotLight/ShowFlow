/**
 * Dry-run of the legacy -> streamlined quality migration: re-score recent
 * grabbed releases and the current library files under BOTH engines and
 * list what flips. Read-only. Backs GET /api/quality/migration-preview.
 *
 * The legacy side reads the untouched legacy tables (custom_formats,
 * profile_formats, profile_qualities, cutoff_quality_id) through the frozen
 * legacy engine; the new side reads the converted profile model.
 */
import type { DatabaseManager } from '../db';
import { legacyQualityEngine, type ReleaseScore as LegacyScore } from './quality_engine_legacy';
import { qualityEngine, type ReleaseScore } from './quality_engine';
import { getProfileCutoff, isCutoffMet, resolveShowProfileId, scoreExistingEpisodeFile, type Scorer } from './cutoff';
import { listProfileModels } from '../db/quality_model';

const legacyScorer: Scorer = {
  byName: (name, pid) => legacyQualityEngine.getReleaseScore(name, pid) as unknown as ReleaseScore,
  byMedia: (probe, pid) => legacyQualityEngine.getReleaseScoreFromMedia(probe, pid) as unknown as ReleaseScore,
};

type Decision = 'accept' | 'reject';
export interface ReleaseRow {
  show: string;
  episode: string | null;
  title: string;
  profileId: string;
  old: { decision: Decision; quality: string | null; total: number; reason: string | null };
  new: { decision: Decision; quality: string | null; total: number; reason: string | null };
  flipped: boolean;
}

export interface WinnerFlip {
  show: string;
  episode: string;
  oldWinner: string | null;
  newWinner: string | null;
}

type CutoffState = 'met' | 'unmet' | 'off';
export interface FileRow {
  show: string;
  episode: string;
  file: string;
  profileId: string;
  old: { quality: string | null; cutoff: CutoffState };
  new: { quality: string | null; cutoff: CutoffState };
  /** What an arriving better release does: old "replace" (import always upgraded), new depends on upgrades. */
  importReplaces: { old: boolean; new: boolean };
  flipped: boolean;
}

export interface MigrationPreview {
  profiles: { id: string; name: string; note: string | null; upgradesEnabled: boolean; terms: number }[];
  summary: {
    releases: number;
    releaseFlips: number;
    winnerFlips: number;
    files: number;
    cutoffFlips: number;
    importNoLongerReplaces: number;
  };
  releases: ReleaseRow[];
  winnerFlips: WinnerFlip[];
  files: FileRow[];
}

function pad(n: number | null | undefined) { return String(n ?? 0).padStart(2, '0'); }
function epLabel(s: number | null, e: number | null) { return s == null || e == null ? null : `S${pad(s)}E${pad(e)}`; }

function sideOf(s: ReleaseScore | LegacyScore) {
  return {
    decision: (s.rejected ? 'reject' : 'accept') as Decision,
    quality: s.qualityName ?? null,
    total: s.totalScore,
    reason: s.rejectReason ?? null,
  };
}

function legacyCutoff(dbm: DatabaseManager, profileId: string): { rank: number; name: string } | null {
  const p = profileId ? dbm.getProfile(profileId) : null;
  if (!p?.cutoff_quality_id) return null;
  const q = dbm.getQuality(p.cutoff_quality_id);
  return q ? { rank: q.rank ?? 0, name: q.name } : null;
}

export function buildMigrationPreview(dbm: DatabaseManager, opts: { limit?: number; onlyFlips?: boolean } = {}): MigrationPreview {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const showRows = dbm.db.query('SELECT id, title, library_type_id, profile FROM shows').all() as { id: string; title: string; library_type_id: string | null; profile: string | null }[];
  const shows = new Map(showRows.map(s => [s.id, s]));
  const profileOf = new Map<string, string>();
  const pid = (showId: string) => {
    let v = profileOf.get(showId);
    if (v === undefined) {
      const s = shows.get(showId);
      v = s ? resolveShowProfileId(dbm, s) : '';
      profileOf.set(showId, v);
    }
    return v;
  };

  // ---- recent grabbed releases
  const grabs = dbm.db.query(`SELECT show_id, season_number, episode_number, release_title FROM grabbed_releases ORDER BY id DESC LIMIT ?`).all(limit) as
    { show_id: string; season_number: number | null; episode_number: number | null; release_title: string }[];
  const releases: ReleaseRow[] = [];
  const byEpisode = new Map<string, { title: string; old: LegacyScore; new: ReleaseScore }[]>();
  for (const g of grabs) {
    const profileId = pid(g.show_id);
    const o = legacyQualityEngine.getReleaseScore(g.release_title, profileId);
    const n = qualityEngine.getReleaseScore(g.release_title, profileId);
    const row: ReleaseRow = {
      show: shows.get(g.show_id)?.title ?? g.show_id,
      episode: epLabel(g.season_number, g.episode_number),
      title: g.release_title,
      profileId,
      old: sideOf(o),
      new: sideOf(n),
      flipped: o.rejected !== n.rejected,
    };
    releases.push(row);
    if (row.episode) {
      const key = `${row.show}\u0000${row.episode}`;
      const list = byEpisode.get(key) ?? [];
      list.push({ title: g.release_title, old: o, new: n });
      byEpisode.set(key, list);
    }
  }

  const winner = (list: { title: string; s: { rejected: boolean; totalScore: number } }[]) => {
    let best: { title: string; total: number } | null = null;
    for (const x of list) if (!x.s.rejected && (!best || x.s.totalScore > best.total)) best = { title: x.title, total: x.s.totalScore };
    return best?.title ?? null;
  };
  const winnerFlips: WinnerFlip[] = [];
  for (const [key, list] of byEpisode) {
    if (list.length < 2) continue;
    const ow = winner(list.map(x => ({ title: x.title, s: x.old })));
    const nw = winner(list.map(x => ({ title: x.title, s: x.new })));
    if (ow !== nw) {
      const [show, episode] = key.split('\u0000');
      winnerFlips.push({ show: show!, episode: episode!, oldWinner: ow, newWinner: nw });
    }
  }

  // ---- current library files
  const fileRows = dbm.db.query(`SELECT show_id, season_number, episode_number, file_path FROM episode_files WHERE is_current = 1 ORDER BY id DESC LIMIT ?`).all(Math.max(limit, 2000)) as
    { show_id: string; season_number: number; episode_number: number; file_path: string }[];
  const files: FileRow[] = [];
  const newCutoffs = new Map<string, ReturnType<typeof getProfileCutoff>>();
  const oldCutoffs = new Map<string, ReturnType<typeof legacyCutoff>>();
  const upgradesOn = new Map<string, boolean>();
  for (const f of fileRows) {
    const profileId = pid(f.show_id);
    if (!newCutoffs.has(profileId)) {
      newCutoffs.set(profileId, getProfileCutoff(dbm, profileId));
      oldCutoffs.set(profileId, legacyCutoff(dbm, profileId));
      upgradesOn.set(profileId, qualityEngine.upgradesAllowed(profileId));
    }
    const nc = newCutoffs.get(profileId)!;
    const oc = oldCutoffs.get(profileId)!;
    const oldScore = scoreExistingEpisodeFile(dbm, f.show_id, f.season_number, f.episode_number, f.file_path, profileId, legacyScorer);
    const newScore = scoreExistingEpisodeFile(dbm, f.show_id, f.season_number, f.episode_number, f.file_path, profileId);
    const oldState: CutoffState = oc ? (isCutoffMet(oldScore.quality, oc) ? 'met' : 'unmet') : 'off';
    const newState: CutoffState = nc ? (isCutoffMet(newScore.quality, nc) ? 'met' : 'unmet') : 'off';
    const replacesNew = upgradesOn.get(profileId)!;
    files.push({
      show: shows.get(f.show_id)?.title ?? f.show_id,
      episode: `S${pad(f.season_number)}E${pad(f.episode_number)}`,
      file: f.file_path.split('/').pop() ?? f.file_path,
      profileId,
      old: { quality: oldScore.quality.qualityName ?? null, cutoff: oldState },
      new: { quality: newScore.quality.qualityName ?? null, cutoff: newState },
      importReplaces: { old: true, new: replacesNew },
      flipped: oldState !== newState || !replacesNew,
    });
  }

  const profiles = listProfileModels(dbm).map(p => ({ id: p.id, name: p.name, note: p.migrationNote, upgradesEnabled: p.upgradesEnabled, terms: p.terms.length }));
  const summary = {
    releases: releases.length,
    releaseFlips: releases.filter(r => r.flipped).length,
    winnerFlips: winnerFlips.length,
    files: files.length,
    cutoffFlips: files.filter(f => f.old.cutoff !== f.new.cutoff).length,
    importNoLongerReplaces: files.filter(f => !f.importReplaces.new).length,
  };
  return {
    profiles,
    summary,
    releases: opts.onlyFlips ? releases.filter(r => r.flipped) : releases,
    winnerFlips,
    files: opts.onlyFlips ? files.filter(f => f.old.cutoff !== f.new.cutoff) : files.slice(0, limit),
  };
}
