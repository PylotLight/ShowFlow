import { db, type Config } from '../db';
import { FilenameParser } from '../parser';
import { debugLog } from './debug';
import fs from 'node:fs';
import path from 'node:path';

export class LibraryScanner {
  private parser = new FilenameParser();

  constructor(private config: Config) {}

  async scan() {
    const rootFolders = db.listRootFolders().map(r => r.path);
    if (this.config.libraryPath) {
      rootFolders.push(this.config.libraryPath);
    }
    if (rootFolders.length === 0) {
      console.log('No root folders configured. Nothing to scan.');
      return;
    }
    console.log(`Scanning ${rootFolders.length} root folder(s): ${rootFolders.join(', ')}`);
    const files: string[] = [];
    for (const rf of rootFolders) {
      try {
        files.push(...this.walk(rf));
      } catch (e) {
        console.warn(`Could not scan root folder ${rf}:`, e);
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
