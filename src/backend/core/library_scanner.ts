import { db, type Config } from '../db';
import { FilenameParser } from '../parser';
import { debugLog } from './debug';
import fs from 'node:fs';
import path from 'node:path';

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
          db.updateEpisodeFilePath(showId, parsed.season, epNum, file);
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
            db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, file);
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

    console.log(`Scan complete. Mapped ${foundCount} episodes. ${unknownCount} files belonged to unknown shows.`);
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
            db.updateEpisodeFilePath(showId, parsed.season, epNum, file);
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
              db.updateEpisodeFilePath(showId, ep.season_number, ep.episode_number, file);
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

    console.log(`Show scan for "${show.title}" complete. Mapped ${foundCount} episodes, cleared ${clearedCount} stale paths.`);
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
