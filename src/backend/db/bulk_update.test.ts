import { test, expect } from "bun:test";
import { db } from "../db";

test("bulkUpdateShows applies library type, series type, and tracking", () => {
  const prefix = `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const showA = `${prefix}_a`;
  const showB = `${prefix}_b`;
  const libraryTypeId = `${prefix}_lt`;
  const qualityId = `${prefix}_p`;

  try {
    db.db.run('PRAGMA foreign_keys = OFF');

    db.saveQuality({ id: `${prefix}_q`, name: 'Bulk Test Quality', rank: 30 });
    db.saveProfile({ id: qualityId, name: 'Bulk Test Profile' });
    db.addProfileQuality(qualityId, `${prefix}_q`);

    db.saveLibraryType({
      id: libraryTypeId,
      name: 'Bulk Test Library',
      rootFolderPath: '/bulk/test/path',
      qualityProfileId: qualityId,
      isDefault: false,
    });

    db.saveShow({
      uuid: showA,
      providerId: `${prefix}_t1`,
      type: 'tmdb',
      title: 'Bulk Show A',
      config: {},
      rootFolderPath: '/original/path',
      seriesType: 'standard',
    });
    db.saveShow({
      uuid: showB,
      providerId: `${prefix}_t2`,
      type: 'tmdb',
      title: 'Bulk Show B',
      config: {},
      rootFolderPath: '/original/path',
      seriesType: 'anime',
    });

    db.saveEpisode({ showId: showA, seasonNumber: 1, episodeNumber: 1, title: 'E1' });
    db.saveEpisode({ showId: showA, seasonNumber: 1, episodeNumber: 2, title: 'E2' });
    db.saveEpisode({ showId: showB, seasonNumber: 1, episodeNumber: 1, title: 'E1' });

    const affected = db.bulkUpdateShows([showA, showB], {
      libraryTypeId,
      seriesType: 'anime',
      tracked: true,
    });
    expect(affected.sort()).toEqual([showA, showB]);

    const showArow = db.getShow(showA);
    const showBrow = db.getShow(showB);
    expect(showArow.library_type_id).toBe(libraryTypeId);
    expect(showArow.series_type).toBe('anime');
    expect(showArow.profile).toBe(qualityId);
    expect(showArow.root_folder_path).toBe('/bulk/test/path');

    expect(showBrow.library_type_id).toBe(libraryTypeId);

    const epsA = db.listAllEpisodes(showA);
    expect(epsA.every(e => e.is_tracked === 1)).toBe(true);

    db.bulkUpdateShows([showA], { tracked: false });
    const epsA2 = db.listAllEpisodes(showA);
    expect(epsA2.every(e => e.is_tracked === 0)).toBe(true);
  } finally {
    db.removeLibraryType(libraryTypeId);
    db.removeShows([showA, showB]);
    db.removeProfile(qualityId);
    db.removeQuality(`${prefix}_q`);
    db.db.run('PRAGMA foreign_keys = ON');
  }
});