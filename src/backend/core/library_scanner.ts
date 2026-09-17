import { db, type Config } from '../db';
import { normalizeShowTitle } from '../db/shows';
import { parseMovieFilename, findMovieShow } from './movie_match';
import { FilenameParser } from '../parser';
import { debugLog } from './debug';
import { sanitizeTitle } from '../shared/sanitize_title';
import {
  isQuarantinableJunk,
  resolveQuarantineDir,
  quarantineFile,
  QUARANTINE_DIR_NAME,
} from './junk_quarantine';
import { probeMediaFile, mediaFromStoredRow, foldProbeToColumns } from './media_probe';
import { qualityEngine } from './quality_engine';
import type { FileMediaColumns, EpisodeFileRow } from '../db/episode_files';
import fs from 'node:fs';
import path from 'node:path';
import { unlink } from 'node:fs/promises';

// Map a scanned/parsed episode assignment to both episodes.file_path and the
// episode_files provenance table. Scanned files have no release provenance
// (they were placed directly on disk), so source_kind stays 'import' unless
// a matching grab exists.
//
// Idempotency (issues-tracking #28): a steady-state scan must be ~free. When
// the live episode_files row already points at this exact path with the same
// size and probed media, nothing changed — skip all writes AND the audit
// event. Previously every scan rewrote every row and logged an event per
// file, appending ~2k rows to episode_files + audit_logs per run; combined
// with overlapping scheduler runs that grew both tables past 3.2M rows and
// wedged the event loop behind synchronous SQLite writes (502s).
// Returns 'changed' when a row was recorded, 'unchanged' when skipped.
async function mapScannedFile(showId: string, season: number, episodeNumber: number, file: string): Promise<'changed' | 'unchanged'> {
  let live: EpisodeFileRow | null = null;
  let size: number | null = null;
  try {
    const st = await fs.promises.stat(file);
    size = st.size;
    live = db.getCurrentEpisodeFile(showId, season, episodeNumber);
  } catch {}
  if (live && live.file_path === file && live.container && live.file_size === size) {
    return 'unchanged';
  }
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
    // (their live rows have no container yet). `live`/`size` were fetched
    // above for the unchanged fast-path — reuse them here.
    let reuseMedia: FileMediaColumns | null = null;
    if (live && live.container && live.file_size === size) {
      reuseMedia = mediaColumnsFromRow(live);
    }

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
    return 'changed';
  } catch (err) {
    debugLog(`Failed to record provenance for ${file}: ${err}`);
    return 'unchanged';
  }
}

async function probeToMediaColumns(file: string): Promise<FileMediaColumns | null> {
  const probe = await probeMediaFile(file);
  return foldProbeToColumns(probe, file.split(/[\\/]/).pop());
}

/** Reuse stored media columns from a live row (unchanged file fast-path). */
function mediaColumnsFromRow(row: EpisodeFileRow): FileMediaColumns {
  return {
    container: row.container,
    video_width: row.video_width,
    video_height: row.video_height,
    video_codec: row.video_codec,
    video_fps: row.video_fps,
    hdr: row.hdr,
    hdr_format: row.hdr_format,
    audio_codec: row.audio_codec,
    audio_channels: row.audio_channels,
    audio_tracks: row.audio_tracks,
    audio_languages: row.audio_languages,
    duration_seconds: row.duration_seconds,
    bitrate_kbps: row.bitrate_kbps,
    release_tags: row.release_tags,
  };
}

/**
 * Narrow a show scan to the show's own folder instead of the whole library
 * root. Derived from the show's existing episode paths (all of one show's
 * files share a single direct child of the root); falls back to the
 * sanitized title folder. The caller verifies the candidate exists and
 * falls back to the full root walk otherwise.
 */
export function resolveShowScanDir(rootFolder: string, title: string, episodePaths: (string | null | undefined)[]): string {
  const sanitized = sanitizeTitle(title);
  const childNames = new Set<string>();
  for (const p of episodePaths) {
    if (!p || !p.startsWith(rootFolder)) continue;
    const rel = p.slice(rootFolder.length).replace(/^[/\\]+/, '');
    const first = rel.split(/[/\\]/)[0];
    if (first) childNames.add(first);
  }
  const folderName = childNames.size === 1 ? [...childNames][0]! : sanitized;
  return path.join(rootFolder, folderName);
}

export class LibraryScanner {
  private parser = new FilenameParser();

  /**
   * Non-video sidecar/junk files (.DS_Store, .t3, download.log, .nfo, …)
   * are skipped silently — they are not parse failures worth logging.
   * Only actual video containers go through the filename parser.
   */
  private static readonly VIDEO_EXTENSIONS = new Set([
    '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.webm', '.mpg', '.mpeg',
  ]);

  private shouldScanFile(file: string): boolean {
    const base = path.basename(file);
    if (base.startsWith('.')) return false;
    return LibraryScanner.VIDEO_EXTENSIONS.has(path.extname(base).toLowerCase());
  }

  /**
   * Movie-file mapping for library scans (#33): parses the filename into a
   * probable title+year, matches a library movie show, and records the file
   * on the (0,0) sentinel — same idempotency/probe/provenance handling as
   * episodes, minus the episodes-table path update (movies have no rows).
   * Returns 'changed' only when a row was actually recorded, so callers can
   * keep the audit log quiet on steady state.
   */
  private async mapMovieFile(file: string, filename: string): Promise<'changed' | 'unchanged'> {
    const movie = parseMovieFilename(filename);
    if (!movie) return 'unchanged';
    const hit = findMovieShow(movie.title, movie.year);
    if (!hit) return 'unchanged';
    const recorded = await this.recordMovieFileForShow(hit.showId, file, filename);
    if (recorded === 'changed') {
      db.logEvent({
        type: 'scan',
        entityType: 'episode',
        entityId: `${hit.showId}:movie`,
        message: `Mapped file ${filename} to movie "${hit.showTitle}"`,
      });
    }
    return recorded;
  }

  /**
   * Per-show variant for scanShow(movie): the show is already known, so no
   * title lookup — just idempotency + probe + record.
   */
  private async mapMovieFileToShow(showId: string, file: string, filename: string): Promise<'changed' | 'unchanged'> {
    const recorded = await this.recordMovieFileForShow(showId, file, filename);
    if (recorded === 'changed') {
      db.logEvent({
        type: 'scan',
        entityType: 'episode',
        entityId: `${showId}:movie`,
        message: `[show scan] Mapped file ${filename} to movie`,
      });
    }
    return recorded;
  }

  private async recordMovieFileForShow(showId: string, file: string, filename: string): Promise<'changed' | 'unchanged'> {
    let live = null;
    let size: number | null = null;
    try {
      const st = await fs.promises.stat(file);
      size = st.size;
      live = db.getMovieFile(showId);
    } catch {
      return 'unchanged';
    }
    if (live && live.file_path === file && live.container && live.file_size === size) {
      return 'unchanged';
    }
    try {
      const grab = db.findMostRecentGrabForShow(showId, 30);
      const media = (live && live.container && live.file_size === size)
        ? mediaColumnsFromRow(live)
        : await probeToMediaColumns(file);
      db.recordMovieFile({
        showId,
        filePath: file,
        originalName: filename,
        fileSize: size,
        sourceKind: grab ? 'release' : 'import',
        releaseTitle: grab?.release_title ?? null,
        indexerName: grab?.indexer_name ?? null,
        publishDate: grab?.publish_date ?? null,
        media,
      });
      return 'changed';
    } catch (err) {
      debugLog(`Failed to record movie provenance for ${file}: ${err}`);
      return 'unchanged';
    }
  }

  constructor(private config: Config) {}

  /**
   * Move a junk file into downloads/.quarantine (when a downloads dir is
   * configured). Returns 'moved' when the file was relocated, 'junk' when
   * it matched the junk predicate but was left in place (no downloads dir,
   * dry-run, oversize, vanished), or null when it isn't junk at all.
   */
  private async maybeQuarantineJunk(
    file: string,
    quarantineDir: string | null,
  ): Promise<'moved' | 'junk' | null> {
    if (!isQuarantinableJunk(path.basename(file))) return null;
    if (!quarantineDir) return 'junk'; // no downloads dir — leave in place, stay quiet
    const outcome = await quarantineFile(file, quarantineDir, { dryRun: this.config.dryRun });
    if (outcome === 'moved') {
      debugLog(`Quarantined junk file ${file}`);
      db.logEvent({
        type: 'scan',
        entityType: 'file',
        message: `Quarantined junk file ${path.basename(file)} (expires after 1 day)`,
      });
      return 'moved';
    }
    return 'junk';
  }

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
    // Movie roots (library types named *movie*) hold films, not episodes.
    // Files there that don't look like episodes are skipped silently and
    // counted — previously every movie logged "Show not found in database"
    // or "Could not parse filename" on EVERY scan (#31). Episode-like files
    // under a movie root still process normally (misplaced shows).
    const withSlash = (r: string) => r.endsWith('/') ? r : `${r}/`;
    const movieRoots = new Set(
      libraryTypes
        .filter(lt => lt.root_folder_path && /movie/i.test(lt.name ?? ''))
        .map(lt => withSlash(lt.root_folder_path!)),
    );
    const underMovieRoot = (f: string) => [...movieRoots].some(r => f.startsWith(r));
    let foundCount = 0;
    let unknownCount = 0;
    let quarantinedCount = 0;
    let moviesSkipped = 0;
    const quarantineDir = resolveQuarantineDir(this.config);

    // Per-show duplicate candidates keyed `${showId}|${season}:${episode}`.
    const candidates = new Map<string, string[]>();
    const addCandidate = (showId: string, season: number, epNum: number, file: string) => {
      const key = `${showId}|${season}:${epNum}`;
      const arr = candidates.get(key) ?? [];
      if (!arr.includes(file)) arr.push(file);
      candidates.set(key, arr);
    };

    for (const file of files) {
      // Known non-media cruft (.DS_Store, download.log, partials, …) is
      // moved to downloads/.quarantine for the daily sweep — not deleted
      // on sight, and never confused with media. Unparseable VIDEO files
      // are left in place: the watch folder + Manual Import page owns those.
      const junkOutcome = await this.maybeQuarantineJunk(file, quarantineDir);
      if (junkOutcome) {
        if (junkOutcome === 'moved') quarantinedCount++;
        continue;
      }
      // Silently skip sidecars, samples metadata, dotfiles, etc.
      if (!this.shouldScanFile(file)) continue;
      const filename = path.basename(file);
      const parsed = this.parser.parse(filename);
      // Films don't parse as episodes and never match a show — skip them
      // quietly when they sit under a movie root (#31).
      const episodeLike = !!parsed && (
        (parsed.season !== undefined && (parsed.episodes?.length ?? 0) > 0) ||
        (parsed.absoluteNumbers?.length ?? 0) > 0
      );
      const isMovieFile = underMovieRoot(file) && !episodeLike;

      if (!parsed) {
        // Unparseable under a movie root: probably a film — try the movie
        // matcher before giving up (#33).
        if (isMovieFile && await this.mapMovieFile(file, filename) === 'changed') { foundCount++; continue; }
        if (isMovieFile) { moviesSkipped++; continue; }
        debugLog(`Could not parse filename: ${filename}`);
        continue;
      }

      // Try to find the show in the DB by name. `getShowByName` does a raw
      // LIKE against the exact parsed title, which misses on-title variants
      // (e.g. "Re - ZERO, ..." on disk vs "Re: ZERO, ..." in the DB) — that
      // leaves on-disk files permanently unmapped/unreconciled. Fall back to
      // the normalized show_titles index (same matching the per-show scan
      // uses) so variant-titled files still get picked up and reconciled.
      let shows = db.getShowByName(parsed.show);
      if (shows.length === 0) {
        const normalized = normalizeShowTitle(parsed.show);
        const normalizedHits = db.findShowsByNormalizedTitle(normalized) ?? [];
        // Normalized lookups return a different shape (showId/showTitle); map
        // to the same shape getShowByName returns so the rest of scan() is
        // agnostic.
        shows = normalizedHits.map((r: any) => ({
          ...r,
          id: r.showId,
          title: r.showTitle,
          original_title: r.showOriginalTitle,
        }));
      }
      if (shows.length === 0) {
        if (isMovieFile && await this.mapMovieFile(file, filename) === 'changed') { foundCount++; continue; }
        if (isMovieFile) { moviesSkipped++; continue; }
        debugLog(`Show not found in database: ${parsed.show} (${filename})`);
        unknownCount++;
        continue;
      }

      // Verify the match actually covers the parsed title (the LIKE path can
      // hit substring false-positives); otherwise skip so we never map a
      // file to the wrong show.
      const show = shows.find((s: any) => this.titleMatchesShow(parsed.show, s.title, s)) ?? shows[0];
      if (!show) {
        if (isMovieFile && await this.mapMovieFile(file, filename) === 'changed') { foundCount++; continue; }
        if (isMovieFile) { moviesSkipped++; continue; }
        debugLog(`Show not found in database: ${parsed.show} (${filename})`);
        unknownCount++;
        continue;
      }
      const showId = show.id;

      if (parsed.season !== undefined && parsed.episodes) {
        for (const epNum of parsed.episodes) {
          addCandidate(showId, parsed.season, epNum, file);
          // Unchanged files are skipped silently — no row rewrite, no audit
          // event (issues-tracking #28). Only real changes get logged.
          if (await mapScannedFile(showId, parsed.season, epNum, file) !== 'changed') continue;
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
            if (await mapScannedFile(showId, ep.season_number, ep.episode_number, file) !== 'changed') continue;
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

    console.log(`Scan complete. Mapped ${foundCount} episodes/movies, quarantined ${quarantinedCount} junk file(s), deleted ${deletedDuplicates} duplicate(s). ${unknownCount} files belonged to unknown shows. Skipped ${moviesSkipped} unmatched movie file(s).`);
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

    // Films have no episode rows — narrow by the movie file (if any),
    // else the `Title (Year)` folder, else the full root.
    if ((show.series_type ?? 'standard') === 'movie') {
      const movieFile = db.getMovieFile(showId);
      let movieDir = rootFolder;
      try {
        if (movieFile) {
          movieDir = path.dirname(movieFile.file_path);
        } else {
          const titled = resolveShowScanDir(rootFolder, `${show.title}${show.year ? ` (${show.year})` : ''}`, []);
          if ((await fs.promises.stat(titled)).isDirectory()) movieDir = titled;
        }
      } catch {}
      console.log(`Scanning movie "${show.title}" in ${movieDir}`);
      let movieFound = 0;
      const quarantineDir = resolveQuarantineDir(this.config);
      try {
        for (const file of this.walk(movieDir)) {
          const junkOutcome = await this.maybeQuarantineJunk(file, quarantineDir);
          if (junkOutcome) continue;
          if (!this.shouldScanFile(file)) continue;
          if (await this.mapMovieFileToShow(showId, file, path.basename(file)) === 'changed') movieFound++;
        }
      } catch (e: any) {
        if (e?.code !== 'ENOENT') console.warn(`Error scanning movie "${show.title}":`, e);
      }
      console.log(`Movie scan complete for "${show.title}". Mapped ${movieFound} file(s).`);
      return;
    }

    // Narrow to the show's own folder (derived from its episode paths)
    // instead of walking the whole library root — a show scan for Reacher
    // must not stat every file of every other show. Falls back to the
    // full root when the show has no files on disk yet.
    let scanDir = rootFolder;
    try {
      const ownedPaths = db.listAllEpisodes(showId)
        .map((e: any) => e.file_path)
        .filter((p: any): p is string => typeof p === 'string' && p.length > 0);
      const candidate = resolveShowScanDir(rootFolder, show.title, ownedPaths);
      if ((await fs.promises.stat(candidate)).isDirectory()) scanDir = candidate;
    } catch {}
    console.log(`Scanning show "${show.title}" in ${scanDir}`);
    let foundCount = 0;
    let quarantinedCount = 0;
    const quarantineDir = resolveQuarantineDir(this.config);
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
      const files = this.walk(scanDir);
      for (const file of files) {
        const junkOutcome = await this.maybeQuarantineJunk(file, quarantineDir);
        if (junkOutcome) {
          if (junkOutcome === 'moved') quarantinedCount++;
          continue;
        }
        // Silently skip sidecars, samples metadata, dotfiles, etc.
        if (!this.shouldScanFile(file)) continue;
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
            if (await mapScannedFile(showId, parsed.season, epNum, file) !== 'changed') continue;
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
              if (await mapScannedFile(showId, ep.season_number, ep.episode_number, file) !== 'changed') continue;
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
        console.log(`Scan folder not found for "${show.title}": ${scanDir}`);
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
      `Show scan for "${show.title}" complete. Mapped ${foundCount} episodes, quarantined ${quarantinedCount} junk file(s), cleared ${clearedCount} stale paths, deleted ${deletedDuplicates} duplicate(s).`,
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

  /**
   * Recursive directory walk that never throws: per-entry errors
   * (EACCES, broken symlinks, files vanishing mid-scan) are skipped with
   * a debug line instead of aborting the whole library scan. Symlinked
   * directories are followed but cycle-guarded via canonical realpaths so
   * a symlink loop can't recurse forever and crash the process.
   */
  private walk(dir: string, seen?: Set<string>): string[] {
    seen ??= new Set<string>();
    let canonical = dir;
    try {
      canonical = fs.realpathSync(dir);
    } catch {
      // Unresolvable root (broken symlink, vanished mount) — nothing to do.
      return [];
    }
    if (seen.has(canonical)) return [];
    seen.add(canonical);

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (e: any) {
      debugLog(`Skipping unreadable directory ${dir}: ${e?.code ?? e?.message ?? e}`);
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      // Never descend into quarantine dirs, even if one sits under a
      // scanned root (e.g. downloads pointed inside a library folder).
      if (entry === QUARANTINE_DIR_NAME) continue;
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        results.push(...this.walk(fullPath, seen));
      } else if (stat.isFile()) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
