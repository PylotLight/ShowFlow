import path from 'node:path';
import { stat } from 'node:fs/promises';
import { db } from '../db';
import type { EpisodeFileRow } from '../db/episode_files';
import { qualityEngine, sourceLabel, type ReleaseScore, type UpgradeExplanation } from './quality_engine';
import { getProfileCutoff, isCutoffMet, resolveShowProfileId } from './cutoff';
import { mediaFromStoredRow, probeMediaFile, type MediaProbeInfo, type ProbeMediaForComparison } from './media_probe';
import { extractReleaseMeta, parseReleaseGroup } from './release_meta';
import { SOURCE_ORDER } from './quality_terms';
import { isSampleFile } from './sample_filter';
import { getImportReason, type ManualImportReasonCode, type RecordedReason } from './manual_import_reasons';

/**
 * Manual Import "why is this file still here?" explanations.
 *
 * For every watch-folder file the list endpoint returns:
 *  - reason:     machine code + badge label + one plain sentence. Taken from
 *                what the importer recorded when it declined the file
 *                (manual_import_reasons.ts), else re-derived here with the
 *                SAME scoring call the importer uses (qualityEngine.explainUpgrade).
 *  - comparison: incoming vs existing side by side (container, size,
 *                resolution, source, codec, HDR, audio, group, quality, score)
 *                with per-field verdicts, plus the profile cutoff status.
 *  - forceImport: what Force Import will actually do (which file(s) it
 *                replaces/deletes, which it keeps).
 */

export type Tone = 'ok' | 'info' | 'warn' | 'error';

export const REASON_META: Record<ManualImportReasonCode, { label: string; tone: Tone }> = {
  NOT_AN_UPGRADE: { label: 'Not an upgrade', tone: 'warn' },
  CUTOFF_MET: { label: 'Cutoff met', tone: 'warn' },
  UPGRADES_OFF: { label: 'Upgrades off', tone: 'warn' },
  REJECTED_BY_PROFILE: { label: 'Rejected by profile', tone: 'error' },
  SAMPLE: { label: 'Sample', tone: 'warn' },
  DUPLICATE: { label: 'Duplicate', tone: 'info' },
  UNMATCHED: { label: 'Unmatched', tone: 'error' },
  PARSE_FAILED: { label: "Can't parse", tone: 'error' },
  NO_ROOT_FOLDER: { label: 'No root folder', tone: 'error' },
  NO_PROFILE: { label: 'No profile', tone: 'error' },
  COLLISION: { label: 'Name collision', tone: 'error' },
  IMPORT_ERROR: { label: 'Error', tone: 'error' },
  IN_PROGRESS: { label: 'Downloading', tone: 'info' },
  UPGRADE_WAITING: { label: 'Upgrade ready', tone: 'ok' },
  NEW_WAITING: { label: 'Ready', tone: 'ok' },
};

export interface ImportReason {
  code: ManualImportReasonCode;
  label: string;
  tone: Tone;
  /** One plain sentence: why it wasn't auto-imported. */
  detail: string;
  /** recorded = what the importer decided at the time; derived = re-computed now. */
  source: 'recorded' | 'derived';
  at?: string;
  /** Extra line when the recorded decision no longer matches current settings. */
  note?: string;
}

export interface FileSide {
  filename: string;
  /** Original release name the existing file was imported from, when known. */
  releaseName?: string | null;
  container: string | null;
  sizeBytes: number | null;
  resolution: number | null;
  source: string | null;
  videoCodec: string | null;
  hdr: string | null;
  audio: string | null;
  releaseGroup: string | null;
  qualityName: string | null;
  rank: number;
  /** Comparison total (rank*1000 + term score), exactly what the importer compares. */
  score: number;
  termScore: number;
  rejected: boolean;
  rejectReason?: string;
  /** Where codec/HDR/audio/resolution came from. */
  detailsFrom: 'probe' | 'filename';
}

export type Verdict = 'better' | 'worse' | 'same' | 'different' | 'larger' | 'smaller' | 'unknown';

export interface FieldDiff {
  field: string;
  label: string;
  incoming: string | null;
  existing: string | null;
  verdict: Verdict;
  note?: string;
}

export interface ImportComparison {
  profileId: string;
  profileName: string | null;
  upgradesAllowed: boolean;
  incoming: FileSide;
  existing: FileSide | null;
  /** Other distinct existing files the incoming one covers (multi-episode). */
  otherExisting: string[];
  diffs: FieldDiff[];
  scoreDelta: number | null;
  sizeDelta: number | null;
  cutoff: { name: string; met: boolean } | null;
  verdict: UpgradeExplanation['verdict'] | 'new';
}

export interface ForceImportEffect {
  action: 'add' | 'replace';
  /** Library files that get deleted once the new file is in place. */
  replaces: string[];
  /** Existing files kept on disk because they also hold episodes outside this file. */
  keeps: string[];
  summary: string;
}

export interface WatchEntryExplanation {
  reason: ImportReason;
  comparison?: ImportComparison;
  forceImport?: ForceImportEffect;
}

// ---- formatting helpers (pure) -------------------------------------------

export function formatBytes(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const fmtScore = (n: number) => n.toLocaleString('en-US');

export function containerFromName(filename: string): string | null {
  const ext = path.extname(filename).replace('.', '');
  return ext ? ext.toUpperCase() : null;
}

export function videoCodecFromName(name: string): string | null {
  if (/\b(?:x\.?265|h\.?265|hevc)\b/i.test(name)) return 'HEVC';
  if (/\b(?:x\.?264|h\.?264|avc)\b/i.test(name)) return 'H.264';
  if (/\bav1\b/i.test(name)) return 'AV1';
  if (/\bvp9\b/i.test(name)) return 'VP9';
  if (/\b(?:xvid|divx)\b/i.test(name)) return 'XviD';
  return null;
}

export function videoCodecFromProbe(codec: string | null | undefined): string | null {
  const c = (codec ?? '').toLowerCase();
  if (!c) return null;
  if (/hevc|h\.?265|hvc1|hev1/.test(c)) return 'HEVC';
  if (/avc|h\.?264/.test(c)) return 'H.264';
  if (/av1|av01/.test(c)) return 'AV1';
  if (/vp9/.test(c)) return 'VP9';
  return c.toUpperCase();
}

function channelsLabel(ch: number | null | undefined): string | null {
  if (!ch) return null;
  if (ch === 1) return '1.0';
  if (ch === 2) return '2.0';
  if (ch === 6) return '5.1';
  if (ch === 8) return '7.1';
  return `${ch}ch`;
}

function audioCodecLabel(raw: string): string | null {
  const c = raw.toLowerCase();
  if (/truehd|mlp/.test(c)) return 'TrueHD';
  if (/dts[\s._-]?hd[\s._-]?ma/.test(c)) return 'DTS-HD MA';
  if (/dts/.test(c)) return 'DTS';
  if (/eac3|e-ac-?3|ec-?3|ddp|dd\+/.test(c)) return 'DD+';
  if (/ac-?3|\bdd\b|dd[257]/.test(c)) return 'DD';
  if (/aac|mp4a/.test(c)) return 'AAC';
  if (/flac/.test(c)) return 'FLAC';
  if (/opus/.test(c)) return 'Opus';
  if (/mp3/.test(c)) return 'MP3';
  if (/pcm|lpcm/.test(c)) return 'PCM';
  return null;
}

export function audioFromName(name: string): string | null {
  const n = name.replace(/[_]+/g, '.');
  let codec: string | null = null;
  if (/\btrue[\s.-]?hd\b/i.test(n)) codec = 'TrueHD';
  else if (/\bdts[\s.-]?hd[\s.-]?ma\b/i.test(n)) codec = 'DTS-HD MA';
  else if (/\bdts\b/i.test(n)) codec = 'DTS';
  else if (/\b(?:ddp|dd\+|e-?ac-?3)/i.test(n)) codec = 'DD+';
  else if (/\b(?:dd|ac-?3)(?:[\s.]?[257][\s.]?[01])?\b/i.test(n)) codec = 'DD';
  else if (/\baac/i.test(n)) codec = 'AAC';
  else if (/\bflac\b/i.test(n)) codec = 'FLAC';
  else if (/\bopus\b/i.test(n)) codec = 'Opus';
  if (!codec) return null;
  const ch = /(?:ddp|dd\+|dd|aac|truehd|dts|flac|opus|ac3|eac3|ma)[\s.]?([1-7])[\s.]([01])\b/i.exec(n);
  const atmos = /\batmos\b/i.test(n) ? ' Atmos' : '';
  return `${codec}${ch ? ` ${ch[1]}.${ch[2]}` : ''}${atmos}`;
}

export function audioFromProbe(probe: Pick<MediaProbeInfo, 'audio'> | null, releaseName?: string | null): string | null {
  const a = probe?.audio?.[0];
  if (!a?.codec) return null;
  const codec = audioCodecLabel(a.codec) ?? a.codec.toUpperCase();
  const ch = channelsLabel(a.channels);
  const atmos = releaseName && /\batmos\b/i.test(releaseName) ? ' Atmos' : '';
  return `${codec}${ch ? ` ${ch}` : ''}${atmos}`;
}

function heightToResolution(h: number | null | undefined, w?: number | null): number | null {
  if (!h) return null;
  const px = w ? w * h : null;
  if ((px != null && px >= 3840 * 2160 * 0.8) || h >= 2000) return 2160;
  if ((px != null && px >= 1920 * 1080 * 0.8) || h >= 1000) return 1080;
  if (h >= 700) return 720;
  if (h >= 540) return 576;
  return 480;
}

/**
 * Describe one side of the comparison. `score` is what the importer compared
 * (for the existing file that's the probe+release merge); `probe` only adds
 * the technical facts (codec/HDR/audio/real resolution) for display.
 */
export function describeSide(input: {
  filename: string;
  releaseName?: string | null;
  sizeBytes?: number | null;
  probe?: ProbeMediaForComparison | null;
  score: ReleaseScore;
}): FileSide {
  const { filename, releaseName, probe, score } = input;
  const nameForTags = releaseName || filename;
  const meta = extractReleaseMeta(nameForTags);
  const probedRes = heightToResolution(probe?.video?.height, probe?.video?.width);
  const hdr = probe?.video
    ? (probe.video.hdr ? meta.hdrFormat ?? 'HDR' : null)
    : meta.hdrFormat;
  return {
    filename,
    releaseName: releaseName && releaseName !== filename ? releaseName : null,
    container: containerFromName(filename),
    sizeBytes: input.sizeBytes ?? probe?.fileSize ?? null,
    resolution: probedRes ?? score.resolution ?? null,
    source: sourceLabel(score.source ?? null),
    videoCodec: videoCodecFromProbe(probe?.video?.codec) ?? videoCodecFromName(nameForTags),
    hdr,
    audio: audioFromProbe(probe ?? null, nameForTags) ?? audioFromName(nameForTags),
    releaseGroup: parseReleaseGroup(nameForTags),
    qualityName: score.qualityName ?? null,
    rank: score.rank,
    score: score.totalScore,
    termScore: score.formatScore,
    rejected: score.rejected,
    ...(score.rejectReason ? { rejectReason: score.rejectReason } : {}),
    detailsFrom: probe?.video ? 'probe' : 'filename',
  };
}

function cmpNum(a: number | null, b: number | null): Verdict {
  if (a == null || b == null) return 'unknown';
  return a > b ? 'better' : a < b ? 'worse' : 'same';
}

function cmpText(a: string | null, b: string | null): Verdict {
  if (a == null && b == null) return 'unknown';
  if (a == null || b == null) return 'different';
  return a.toLowerCase() === b.toLowerCase() ? 'same' : 'different';
}

function sourceIdx(label: string | null): number | null {
  if (!label) return null;
  const i = SOURCE_ORDER.findIndex((s) => sourceLabel(s) === label);
  return i < 0 ? null : i;
}

/** Field-by-field verdicts, from the incoming file's point of view. */
export function diffSides(incoming: FileSide, existing: FileSide): FieldDiff[] {
  const out: FieldDiff[] = [];
  const res = (r: number | null) => (r ? `${r}p` : null);
  const delta = incoming.score - existing.score;

  out.push({
    field: 'score', label: 'Score',
    incoming: incoming.rejected ? 'rejected' : fmtScore(incoming.score),
    existing: existing.rejected ? 'rejected' : fmtScore(existing.score),
    verdict: incoming.rejected ? 'worse' : cmpNum(incoming.score, existing.score),
    note: incoming.rejected ? incoming.rejectReason : `${delta >= 0 ? '+' : ''}${fmtScore(delta)}`,
  });
  out.push({
    field: 'quality', label: 'Quality',
    incoming: incoming.qualityName, existing: existing.qualityName,
    verdict: incoming.rank > 0 && existing.rank > 0 ? cmpNum(incoming.rank, existing.rank) : cmpText(incoming.qualityName, existing.qualityName),
  });
  out.push({ field: 'resolution', label: 'Resolution', incoming: res(incoming.resolution), existing: res(existing.resolution), verdict: cmpNum(incoming.resolution, existing.resolution) });

  const si = sourceIdx(incoming.source);
  const se = sourceIdx(existing.source);
  // Lower SOURCE_ORDER index = better source.
  out.push({
    field: 'source', label: 'Source', incoming: incoming.source, existing: existing.source,
    verdict: si != null && se != null ? (si < se ? 'better' : si > se ? 'worse' : 'same') : cmpText(incoming.source, existing.source),
  });
  out.push({ field: 'videoCodec', label: 'Video', incoming: incoming.videoCodec, existing: existing.videoCodec, verdict: cmpText(incoming.videoCodec, existing.videoCodec) });
  out.push({
    field: 'hdr', label: 'HDR', incoming: incoming.hdr ?? 'SDR', existing: existing.hdr ?? 'SDR',
    verdict: incoming.hdr && !existing.hdr ? 'better' : !incoming.hdr && existing.hdr ? 'worse' : cmpText(incoming.hdr ?? 'SDR', existing.hdr ?? 'SDR'),
  });
  out.push({ field: 'audio', label: 'Audio', incoming: incoming.audio, existing: existing.audio, verdict: cmpText(incoming.audio, existing.audio) });

  const sz = incoming.sizeBytes != null && existing.sizeBytes != null ? incoming.sizeBytes - existing.sizeBytes : null;
  out.push({
    field: 'size', label: 'Size', incoming: formatBytes(incoming.sizeBytes), existing: formatBytes(existing.sizeBytes),
    verdict: sz == null ? 'unknown' : sz > 0 ? 'larger' : sz < 0 ? 'smaller' : 'same',
    ...(sz != null && sz !== 0 ? { note: `${sz > 0 ? '+' : '-'}${formatBytes(Math.abs(sz))}` } : {}),
  });
  out.push({ field: 'container', label: 'Container', incoming: incoming.container, existing: existing.container, verdict: cmpText(incoming.container, existing.container) });
  out.push({ field: 'group', label: 'Group', incoming: incoming.releaseGroup, existing: existing.releaseGroup, verdict: cmpText(incoming.releaseGroup, existing.releaseGroup) });
  return out;
}

/** What drives a not-better verdict, in a few words ("incoming is WEBRip-1080p, existing is WEBDL-1080p"). */
function whyNotBetter(expl: UpgradeExplanation): string {
  const n = expl.newcomer;
  const e = expl.existing;
  if (n.qualityName && e.qualityName && n.rank !== e.rank) {
    return `incoming is ${n.qualityName}, existing is ${e.qualityName}`;
  }
  if (n.formatScore !== e.formatScore) {
    return `same quality${n.qualityName ? ` (${n.qualityName})` : ''}, but preferred-terms score is ${n.formatScore} vs ${e.formatScore}`;
  }
  return `same quality${n.qualityName ? ` (${n.qualityName})` : ''} and same preferred-terms score`;
}

/**
 * The reason for an upgrade decision. Used both by the importer when it
 * declines (so it's recorded) and by the list when re-deriving.
 */
export function upgradeReason(
  expl: UpgradeExplanation,
  cutoff: { name: string; met: boolean } | null,
  existingFilename: string,
): { code: ManualImportReasonCode; detail: string } {
  const scores = `${fmtScore(expl.newcomer.totalScore)} vs ${fmtScore(expl.existing.totalScore)}`;
  switch (expl.verdict) {
    case 'upgrades_off':
      return {
        code: 'UPGRADES_OFF',
        detail: `Upgrades are turned off in the ${expl.profileName ? `"${expl.profileName}"` : "show's"} quality profile, so an import never replaces the existing file "${existingFilename}".`,
      };
    case 'rejected':
      return { code: 'REJECTED_BY_PROFILE', detail: `The quality profile rejects the incoming file: ${expl.newcomer.rejectReason ?? 'not allowed'}.` };
    case 'sample':
      return { code: 'SAMPLE', detail: 'Looks like a release sample, which is never imported over a real file.' };
    case 'upgrade':
      return {
        code: 'UPGRADE_WAITING',
        detail: `Would upgrade the existing file (score ${scores}). It hasn't been processed yet; it'll import on the next watch-folder scan, or Force Import now.`,
      };
    default: {
      const cmp = expl.verdict === 'equal' ? 'the same score as' : 'a lower score than';
      const why = whyNotBetter(expl);
      if (cutoff?.met) {
        return {
          code: 'CUTOFF_MET',
          detail: `Existing file already meets the profile cutoff (${cutoff.name}), and the incoming file has ${cmp} it (${scores}; ${why}).`,
        };
      }
      return {
        code: 'NOT_AN_UPGRADE',
        detail: `Incoming file has ${cmp} the existing one (${scores}; ${why}). An import must score strictly higher to replace it.`,
      };
    }
  }
}

/** Cutoff status of an existing file's score under a profile (null when upgrades are off). */
export function cutoffStatus(profileId: string, existing: ReleaseScore): { name: string; met: boolean } | null {
  const cutoff = getProfileCutoff(db, profileId);
  if (!cutoff) return null;
  return {
    name: cutoff.name,
    met: isCutoffMet({ rank: existing.rank, qualityName: existing.qualityName ?? null, termScore: existing.rejected ? null : existing.formatScore }, cutoff),
  };
}

/** Code for an unresolved watch-folder file, from the resolver's message. */
export function unresolvedCode(error: string | undefined): ManualImportReasonCode {
  if (error && /could not parse/i.test(error)) return 'PARSE_FAILED';
  return 'UNMATCHED';
}

export function makeReason(code: ManualImportReasonCode, detail: string, source: ImportReason['source'], extra: Partial<ImportReason> = {}): ImportReason {
  const meta = REASON_META[code];
  return { code, label: meta.label, tone: meta.tone, detail, source, ...extra };
}

export function fromRecorded(r: RecordedReason): ImportReason {
  const code = (r.code in REASON_META ? r.code : 'IMPORT_ERROR') as ManualImportReasonCode;
  return makeReason(code, r.message, 'recorded', { at: r.at });
}

// ---- probe cache (bounded) -------------------------------------------------

const PROBE_CACHE_MAX = 256;
const PROBE_TIMEOUT_MS = 4000;
const probeCache = new Map<string, MediaProbeInfo | null>();

/**
 * Probe for display only, cached by path+size+mtime. Never runs the
 * whole-file duration scan, times out, and never throws.
 */
export async function cachedProbe(filePath: string, budget?: { left: number }): Promise<MediaProbeInfo | null> {
  let key: string;
  try {
    const st = await stat(filePath);
    key = `${filePath}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  if (probeCache.has(key)) {
    const v = probeCache.get(key)!;
    probeCache.delete(key);
    probeCache.set(key, v);
    return v;
  }
  if (budget) {
    if (budget.left <= 0) return null;
    budget.left--;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    probeMediaFile(filePath, { skipComputeDuration: true }),
    new Promise<null>((r) => { timer = setTimeout(() => r(null), PROBE_TIMEOUT_MS); }),
  ]).catch(() => null);
  if (timer) clearTimeout(timer);
  probeCache.set(key, result);
  while (probeCache.size > PROBE_CACHE_MAX) {
    const first = probeCache.keys().next().value;
    if (first === undefined) break;
    probeCache.delete(first);
  }
  return result;
}

export function _clearProbeCacheForTests() {
  probeCache.clear();
}

// ---- orchestration ---------------------------------------------------------

export interface WatchEntryInput {
  filename: string;
  fullPath: string;
  show?: string;
  showId?: string;
  kind?: 'movie' | 'episode';
  season?: number;
  episodes?: number[];
  resolved: boolean;
  held?: boolean;
  error?: string;
}

/** The stored file's media, exactly as the importer reads it before comparing. */
async function existingProbeFor(row: EpisodeFileRow | null, filePath: string, budget: { left: number }): Promise<ProbeMediaForComparison | null> {
  if (row?.container) return mediaFromStoredRow(row);
  // Importer: an orphan file (no stored media) is probed on disk.
  return cachedProbe(filePath, budget);
}

/**
 * Split the existing files an import would touch into replaced (all their
 * episodes are covered by the new file) and kept (also hold another episode).
 * Shared with BlackholeClient.planEpisodeReplacement.
 */
export function splitReplaceKept(showId: string, covered: Set<string>, filePaths: string[]): { replace: string[]; kept: string[] } {
  const replace: string[] = [];
  const kept: string[] = [];
  for (const filePath of filePaths) {
    const holders = db.db.query(
      `SELECT season_number, episode_number FROM episodes WHERE show_id = ? AND file_path = ?`,
    ).all(showId, filePath) as Array<{ season_number: number; episode_number: number }>;
    const allCovered = holders.every((h) => covered.has(`${h.season_number}:${h.episode_number}`));
    (allCovered ? replace : kept).push(filePath);
  }
  return { replace, kept };
}

function forceEffect(replace: string[], kept: string[]): ForceImportEffect {
  const r = replace.map((p) => path.basename(p));
  const k = kept.map((p) => path.basename(p));
  if (r.length === 0 && k.length === 0) {
    return { action: 'add', replaces: [], keeps: [], summary: 'Imports the file into the library. Nothing existing is touched.' };
  }
  const parts: string[] = [];
  if (r.length) parts.push(`Replaces ${r.map((n) => `"${n}"`).join(', ')}; the old file is deleted once the new one is in place.`);
  if (k.length) parts.push(`Keeps ${k.map((n) => `"${n}"`).join(', ')} because it also holds episodes outside this file.`);
  return { action: r.length ? 'replace' : 'add', replaces: r, keeps: k, summary: parts.join(' ') };
}

/**
 * Explain one watch-folder entry. `budget` caps how many uncached probes a
 * single listing may run so a big folder can't stall the endpoint.
 */
export async function explainWatchEntry(entry: WatchEntryInput, budget: { left: number } = { left: 25 }): Promise<WatchEntryExplanation> {
  let size: number | null = null;
  try { size = (await stat(entry.fullPath)).size; } catch {}
  const recorded = getImportReason(entry.fullPath, size);
  const recordedReason = recorded ? fromRecorded(recorded) : null;

  if (!entry.resolved) {
    if (recordedReason && recordedReason.code !== 'UPGRADE_WAITING' && recordedReason.code !== 'NEW_WAITING') return { reason: recordedReason };
    const code = unresolvedCode(entry.error);
    return {
      reason: makeReason(code, entry.error ?? 'Could not match this file to a show in the library. Use Match Show to pick one.', 'derived'),
    };
  }

  const show = entry.showId ? db.getShow(entry.showId) : null;
  const profileId = (show ? resolveShowProfileId(db, show) : '') || 'standard';

  // Existing files this import would compare against / replace.
  const existingRows: Array<{ filePath: string; row: EpisodeFileRow | null }> = [];
  const covered = new Set<string>();
  if (show) {
    if (entry.kind === 'movie') {
      const row = db.getMovieFile(show.id);
      if (row?.file_path) existingRows.push({ filePath: row.file_path, row });
    } else if (entry.season != null && entry.episodes?.length) {
      const seen = new Set<string>();
      for (const e of entry.episodes) {
        covered.add(`${entry.season}:${e}`);
        const ep = db.getEpisode(show.id, entry.season, e);
        if (!ep?.file_path || seen.has(ep.file_path)) continue;
        seen.add(ep.file_path);
        existingRows.push({ filePath: ep.file_path, row: db.getCurrentEpisodeFile(show.id, entry.season, e) });
      }
    }
  }

  // Incoming side: the importer scores it from its filename; the probe is display only.
  const incomingProbe = await cachedProbe(entry.fullPath, budget);

  // Compare against every distinct existing file; the first one it doesn't beat decides.
  let decisive: { filePath: string; row: EpisodeFileRow | null; expl: UpgradeExplanation; probe: ProbeMediaForComparison | null } | null = null;
  for (const { filePath, row } of existingRows) {
    const probe = await existingProbeFor(row, filePath, budget);
    const expl = qualityEngine.explainUpgrade(probe, path.basename(filePath), entry.filename, profileId, row?.release_title || row?.original_name);
    if (!decisive || (decisive.expl.isUpgrade && !expl.isUpgrade)) decisive = { filePath, row, expl, probe };
    if (!expl.isUpgrade) break;
  }

  const newcomerScore = decisive?.expl.newcomer ?? qualityEngine.getReleaseScore(entry.filename, profileId);
  const incoming = describeSide({ filename: entry.filename, sizeBytes: size, probe: incomingProbe, score: newcomerScore });

  let existing: FileSide | null = null;
  let cutoff: { name: string; met: boolean } | null = null;
  if (decisive) {
    let existingSize: number | null = decisive.row?.file_size ?? null;
    if (existingSize == null) { try { existingSize = (await stat(decisive.filePath)).size; } catch {} }
    existing = describeSide({
      filename: path.basename(decisive.filePath),
      releaseName: decisive.row?.release_title || decisive.row?.original_name || null,
      sizeBytes: existingSize,
      probe: decisive.probe,
      score: decisive.expl.existing,
    });
    cutoff = cutoffStatus(profileId, decisive.expl.existing);
  }

  const upgradesAllowed = decisive?.expl.upgradesAllowed ?? qualityEngine.upgradesAllowed(profileId);
  const comparison: ImportComparison = {
    profileId,
    profileName: decisive?.expl.profileName ?? null,
    upgradesAllowed,
    incoming,
    existing,
    otherExisting: existingRows.map((r) => path.basename(r.filePath)).filter((n) => n !== existing?.filename),
    diffs: existing ? diffSides(incoming, existing) : [],
    scoreDelta: existing ? incoming.score - existing.score : null,
    sizeDelta: existing && incoming.sizeBytes != null && existing.sizeBytes != null ? incoming.sizeBytes - existing.sizeBytes : null,
    cutoff,
    verdict: decisive?.expl.verdict ?? 'new',
  };

  const { replace, kept } = show && entry.kind !== 'movie'
    ? splitReplaceKept(show.id, covered, existingRows.map((r) => r.filePath))
    : { replace: existingRows.map((r) => r.filePath), kept: [] as string[] };
  const forceImport = forceEffect(replace, kept);

  // Re-derived reason with the importer's own rules.
  let derived: ImportReason;
  if (decisive) {
    const u = upgradeReason(decisive.expl, cutoff, path.basename(decisive.filePath));
    derived = makeReason(u.code, u.detail, 'derived');
  } else if (newcomerScore.rejected) {
    derived = makeReason('REJECTED_BY_PROFILE', `The quality profile rejects this file: ${newcomerScore.rejectReason ?? 'not allowed'}.`, 'derived');
  } else if (isSampleFile(entry.filename)) {
    derived = makeReason('SAMPLE', 'Looks like a release sample, which is never imported.', 'derived');
  } else if (show && !db.getShowRootFolder(show.id)) {
    derived = makeReason('NO_ROOT_FOLDER', `No root folder is configured for "${show.title}". Assign a show profile with a root folder.`, 'derived');
  } else {
    derived = makeReason(
      'NEW_WAITING',
      show
        ? "Nothing in the library for this yet. It hasn't been processed; it'll import on the next watch-folder scan, or Force Import now."
        : `"${entry.show ?? 'This show'}" isn't in the library yet; importing will add it.`,
      'derived',
    );
  }
  if (entry.held && !recordedReason && (derived.code === 'UPGRADE_WAITING' || derived.code === 'NEW_WAITING')) {
    derived = {
      ...derived,
      detail: `${derived.code === 'UPGRADE_WAITING' ? `Would upgrade the existing file (score ${fmtScore(incoming.score)} vs ${fmtScore(existing?.score ?? 0)})` : 'Nothing in the library blocks this'}. It was held from an earlier attempt whose reason wasn't recorded (before this version); rescan the watch folder to retry, or Force Import.`,
    };
  }

  let reason = recordedReason ?? derived;
  if (recordedReason && recordedReason.code !== derived.code && (derived.code === 'UPGRADE_WAITING' || derived.code === 'NEW_WAITING')) {
    reason = { ...recordedReason, note: 'Under the current profile this would now import. Rescan the watch folder to retry, or Force Import.' };
  }
  return { reason, comparison, forceImport };
}
