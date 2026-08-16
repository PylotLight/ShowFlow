import { db, type Config } from '../db';
import { FilenameParser } from '../parser';
import { debugLog } from './debug';
import { probeMediaFile, mediaFromStoredRow } from './media_probe';
import { qualityEngine } from './quality_engine';
import type { FileMediaColumns } from '../db/episode_files';
import fs from 'node:fs';
import path from 'node:path';
import { unlink } from 'node:fs/promises';

// Map a scanned/parsed episode assignment to both episodes.file_path and the
// episode_files provenance table. Scanned files have no release provenance
// (they were placed directly on disk), so source_kind stays 'import' unless
// a matching grab exists.
async function mapScannedFile(showId: string, season: number, episodeNumber: number, file: string) {
  db.updateEpisodeFilePath(showId, season, episodeNumber, file);
  try {
    const grab = db.findGrabbedReleaseForShowEpisode(showId, season, episodeNumber, 30);
    // Probe the on-disk file so the episode_files row carries its real
    // resolution/codec/bitrate (media badges + media-aware upgrade compare).
    //
    // Re-probing every file on every scan is ~50ms each, so skip it when the
    // live row already has media for an unchanged file (same size on disk),
    // reusing the stored media columns instead. This still backfills the 100s
    // of pre-existing library files on the first scan after the feature ships
    // (their live rows have no container yet).
    let reuseMedia: FileMediaColumns | null = null;
    try {
      const st = await fs.promises.stat(file);
      const live = db.getCurrentEpisodeFile(showId, season, episodeNumber);
      if (live && live.container && live.file_size === st.size) {
        reuseMedia = {
          container: live.container,
          video_width: live.video_width,
          video_height: live.video_height,
          video_codec: live.video_codec,
          video_fps: live.video_fps,
          hdr: live.hdr,
          audio_codec: live.audio_codec,
          audio_channels: live.audio_channels,
          duration_seconds: live.duration_seconds,
          bitrate_kbps: live.bitrate_kbps,
        };
      }
    } catch {}

    const media = reuseMedia ?? await probeToMediaColumns(file);
    db.recordEpisodeFile({
      showId,
      season,
      episode: episodeNumber,
      filePath: file,
      originalName: file.split(/[\\/]/).pop() ?? file,
      sourceKind: grab ? 'release' : 'import',
      releaseTitle: grab?.release_title ?? null,
      indexerName: grab?.indexer_name ?? null,
      publishDate: grab?.publish_date ?? null,
      media,
    });
  } catch (err) {
    debugLog(`Failed to record provenance for ${file}: ${err}`);
  }
}

async function probeToMediaColumns(file: string): Promise<FileMediaColumns | null> {
  const probe = await probeMediaFile(file);
  if (!probe) return null;
  return {
    container: probe.container,
    video_width: probe.video?.width ?? null,
    video_height: probe.video?.height ?? null,
    video_codec: probe.video?.codec?.toLowerCase() ?? null,
    video_fps: probe.video?.fps ? Math.round(probe.video.fps) : null,
    hdr: probe.video?.hdr ? 1 : null,
    audio_codec: probe.audio?.[0]?.codec?.toLowerCase() ?? null,
    audio_channels: probe.audio?.[0]?.channels ?? null,
    duration_seconds: probe.durationSeconds ? Math.round(probe.durationSeconds) : null,
    bitrate_kbps: probe.overallBitrate ? Math.round(probe.overallBitrate / 1000) : null,
  };
}

export class LibraryScanner {
  private parser = new FilenameParser();

  constructor(private config: Config) {}

  async scan() {
    const profiles = db.listShowProfiles();
    const libraryTypes = db.listLibraryTypes();
    const rootFolders = [
      ...new Set([
        ...profiles.map(p => p.root_folder_path),
        ...libraryTypes.filter(lt => lt.root_folder_path).map(lt => lt.root_folder_path),
      ])
    ];
    if (rootFolders.length === 0) {
      console.log('No profiles or library types with root folders configured. Nothing to scan.');
      return;
    }
    console.log(`Scanning ${rootFolders.length} root folder(s): ${rootFolders.join(', ')}`);
    const files: string[] = [];
    for (const rf of rootFolders) {
      try {
        files.push(...this.walk(rf));
      } catch (e: any) {
        if (e?.code === 'ENOENT') {
          debugLog(`Root folder not found: ${rf}`);
        } else {
          console.warn(`Could not scan root folder ${rf}:`, e);
        }
      }
    }
    let foundCount = 0;
    let unknownCount = 0;

    // Per-show duplicate candidates keyed `${showId}|${season}:${episode}`.
    const candidates = new Map<string, string[]>();
    const addCandidate = (showId: string, season: number, epNum: number, file: string) => {
      const key = `${showId}|${season}:${epNum}`;
      const arr = candidates.get(key) ?? [];
      if (!arr.includes(file)) arr.push(file);
      candidates.set(key, arr);
    };

    for (const file of files) {
      const filename = path.basename(file);
      const parsed = this.parser.parse(filename);

      if (!parsed) {
        debugLog(`Could not parse filename: ${filename}`);
        continue;
      }

      // Try to find the show in the DB by name
      const shows = db.getShowByName(parsed.show);
      if (shows.length === 0) {
        debugLog(`Show not found in database: ${parsed.show} (${filename})`);
        unknownCount++;
        continue;
      }

      // Use the first match
      const show = shows[0];
      const showId = show.id;

      if (parsed.season !== undefined && parsed.episodes) {
        for (const epNum of parsed.episodes) {
          addCandidate(showId, parsed.season, epNum, file);
          await mapScannedFile(showId, parsed.season, epNum, file);
          foundCount++;
          db.logEvent({
            type: 'scan',
            entityType: 'episode',
            entityId: `${showId}:${parsed.season}:${epNum}`,
            message: `Mapped file ${path.basename(file)} to episode`,
          });
        }
      } else if (parsed.absoluteNumbers) {
        // Absolute numbers are trickier because we need to map them to SxxExx
        // For now, we'll just log them or try to find the episode by absolute_number
        // since our DB stores absolute_number.
        const episodes = db.listAllEpisodes(showId);
        for (const absNum of parsed.absoluteNumbers) {
          const ep = episodes.find(e => e.absolute_number === absNum);
          if (ep) {
            addCandidate(showId, ep.season_number, ep.episode_number, file);
            await mapScannedFile(showId, ep.season_number, ep.episode_number, file);
            foundCount++;
            db.logEvent({
              type: 'scan',
              entityType: 'episode',
              entityId: `${showId}:${ep.season_number}:${ep.episode_number}`,
              message: `Mapped file ${path.basename(file)} to episode via absolute number`,
            });
          } else {
            debugLog(`Absolute episode ${absNum} not found for show ${parsed.show}`);
          }
        }
      }
    }

    // Library-wide duplicate cleanup: same reconciliation the per-show scan
    // runs, so any two on-disk copies of one episode across the library keep
    // only the best-scoring file.
    let deletedDuplicates = 0;
    for (const [key, files] of candidates) {
      if (files.length < 2) continue;
      const splitKey = key.split('|');
      const showId = splitKey[0];
      const sep = splitKey[1];
      if (!showId || !sep) continue;
      const split = sep.split(':');
      deletedDuplicates += await this.reconcileDuplicates(
        showId, Number(split[0]), Number(split[1]), files,
      );
    }

    if (deletedDuplicates > 0) {
      db.logEvent({
        type: 'scan',
        entityType: 'system',
        message: `Library scan removed ${deletedDuplicates} duplicate episode file(s)`,
      });
    }

    console.log(`Scan complete. Mapped ${foundCount} episodes, deleted ${deletedDuplicates} duplicate(s). ${unknownCount} files belonged to unknown shows.`);
  }

  private normalizeForMatch(value: string): string {
    return value
      .normalize('NFKC')
      .replace(/[._]+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  private titleMatchesShow(parsedTitle: string, showTitle: string, show: any): boolean {
    const normalParsed = this.normalizeForMatch(parsedTitle);
    const normalCanonical = this.normalizeForMatch(showTitle);

    if (normalParsed === normalCanonical) return true;
    if (normalCanonical.includes(normalParsed) || normalParsed.includes(normalCanonical)) return true;

    if (show.original_title) {
      const normalOriginal = this.normalizeForMatch(show.original_title);
      if (normalParsed === normalOriginal) return true;
      if (normalOriginal.includes(normalParsed) || normalParsed.includes(normalOriginal)) return true;
    }

    return false;
  }

  async scanShow(showId: string) {
    const show = db.getShow(showId);
    if (!show) {
      console.log(`Show ${showId} not found. Nothing to scan.`);
      return;
    }

    const libraryRoot = show.library_type_id ? (db.getLibraryType(show.library_type_id)?.root_folder_path ?? null) : null;
    const rootFolder = libraryRoot || show.root_folder_path || db.getShowRootFolder(showId);
    if (!rootFolder) {
      console.log(`No root folder for show "${show.title}". Nothing to scan.`);
      return;
    }

    console.log(`Scanning show "${show.title}" in ${rootFolder}`);
    let foundCount = 0;

    // Group candidate files per (season, episode) so that after mapping we can
    // find and clean up duplicate copies of the same episode on disk (the
    // Reacher S04E01 case where both a 1080p WEBRip and a 2160p sat side by
    // side). Only the best copy should be kept + become episodes.file_path.
    const candidatesByEpisode = new Map<string, string[]>();

    const keyFor = (season: number, ep: number) => `${season}:${ep}`;
    const addCandidate = (season: number, epNum: number, file: string) => {
      const key = keyFor(season, epNum);
      const arr = candidatesByEpisode.get(key) ?? [];
      if (!arr.includes(file)) arr.push(file);
      candidatesByEpisode.set(key, arr);
    };

    try {
      const files = this.walk(rootFolder);
      for (const file of files) {
        const filename = path.basename(file);
        const parsed = this.parser.parse(filename);

        if (!parsed) {
          debugLog(`Could not parse filename: ${filename}`);
          continue;
        }

        if (!this.titleMatchesShow(parsed.show, show.title, show)) {
          debugLog(`Skipping file "${filename}" — parsed title "${parsed.show}" does not match show "${show.title}"`);
          continue;
        }

        if (parsed.season !== undefined && parsed.episodes) {
          for (const epNum of parsed.episodes) {
            addCandidate(parsed.season, epNum, file);
            await mapScannedFile(showId, parsed.season, epNum, file);
            foundCount++;
            db.logEvent({
              type: 'scan',
              entityType: 'episode',
              entityId: `${showId}:${parsed.season}:${epNum}`,
              message: `[show scan] Mapped file ${filename} to ${show.title} S${parsed.season}E${epNum}`,
            });
          }
        } else if (parsed.absoluteNumbers) {
          const episodes = db.listAllEpisodes(showId);
          for (const absNum of parsed.absoluteNumbers) {
            const ep = episodes.find((e: any) => e.absolute_number === absNum);
            if (ep) {
              addCandidate(ep.season_number, ep.episode_number, file);
              await mapScannedFile(showId, ep.season_number, ep.episode_number, file);
              foundCount++;
              db.logEvent({
                type: 'scan',
                entityType: 'episode',
                entityId: `${showId}:${ep.season_number}:${ep.episode_number}`,
                message: `[show scan] Mapped file ${filename} to ${show.title} via absolute number`,
              });
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        console.log(`Root folder not found for "${show.title}": ${rootFolder}`);
      } else {
        console.warn(`Error scanning show "${show.title}":`, e);
      }
    }

    // Reconcile: clear file paths for episodes whose files no longer exist
    const allEpisodes = db.listAllEpisodes(showId);
    let clearedCount = 0;
    for (const ep of allEpisodes) {
      if (ep.file_path) {
        try {
          await fs.promises.access(ep.file_path);
        } catch {
          db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, '');
          clearedCount++;
        }
      }
    }

    // Clean up duplicate copies of the same episode on disk: keep only the
    // best-scoring file (resolution/bitrate/codec from the probe we just
    // recorded), delete the rest, and point episodes.file_path + the current
    // episode_files row at the survivor.
    let deletedDuplicates = 0;
    for (const [key, files] of candidatesByEpisode) {
      if (files.length < 2) continue;
      const split = key.split(':');
      const season = Number(split[0]);
      const epNum = Number(split[1]);
      const cleaned = await this.reconcileDuplicates(showId, season, epNum, files);
      deletedDuplicates += cleaned;
    }

    console.log(
      `Show scan for "${show.title}" complete. Mapped ${foundCount} episodes, cleared ${clearedCount} stale paths, deleted ${deletedDuplicates} duplicate(s).`,
    );
  }

  /**
   * Given several on-disk files that all map to the same (show, season, ep),
   * probe/score each and keep the single best one; delete the rest. Returns
   * the number of deleted files. The survivor's file_path is written to
   * episodes.file_path and the episode_files row is re-recorded as current.
   */
  private async reconcileDuplicates(showId: string, season: number, episode: number, files: string[]): Promise<number> {
    const profileId = db.getShow(showId)?.profile ?? 'standard';
    const scored = new Map<
      string,
      { path: string; score: number; rowId: number | null; kept?: boolean }
    >();

    for (const file of files) {
      let exists = false;
      try {
        await fs.promises.access(file);
        exists = true;
      } catch {}
      if (!exists) {
        debugLog(`Duplicate candidate gone during scan: ${file}`);
        continue;
      }

      const row = db.getCurrentEpisodeFile(showId, season, episode);
      let media = row?.file_path === file ? mediaFromStoredRow(row) : null;
      if (!media) {
        const probe = await probeMediaFile(file);
        if (!probe) {
          // Unprobeable file (or a zero-byte/tmp partial): never deletes the
          // other copy on its behalf; just ignore it.
          debugLog(`Could not probe duplicate candidate ${file}`);
          continue;
        }
        media = probe;
      }

      const score = qualityEngine.getReleaseScoreFromMedia(media, profileId);
      scored.set(file, { path: file, score: score.totalScore, rowId: row?.file_path === file ? row.id : null });
    }

    if (scored.size < 2) return 0;

    const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0]!;
    let deleted = 0;

    for (const candidate of ranked.slice(1)) {
      if (candidate.score === best.score && candidate.path === best.path) continue;
      try {
        await unlink(candidate.path);
        deleted++;
        db.logEvent({
          type: 'delete',
          entityType: 'file',
          entityId: showId,
          message: `Removed duplicate ${path.basename(candidate.path)} (kept ${path.basename(best.path)})`,
        });
      } catch (e: any) {
        console.warn(`Could not delete duplicate ${candidate.path}:`, e?.message ?? e);
      }
    }

    // Point the episode at the surviving file and make it the live row.
    // During the mapping pass every duplicate was recorded, so the current
    // row may point at a JUST-DELETED loser; re-recording the survivor sets
    // is_current=1 on it (and demotes the stale row), and fixes
    // episodes.file_path to the path that still exists.
    const bestRow = db.getCurrentEpisodeFile(showId, season, episode);
    if (!bestRow?.file_path || bestRow.file_path !== best.path) {
      db.recordEpisodeFile({
        showId,
        season,
        episode,
        filePath: best.path,
        originalName: best.path.split(/[\\/]/).pop() ?? best.path,
        sourceKind: 'import',
        media: await probeToMediaColumns(best.path),
      });
      db.updateEpisodeFilePath(showId, season, episode, best.path);
    }

    return deleted;
  }

  private walk(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        results = results.concat(this.walk(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }
}
