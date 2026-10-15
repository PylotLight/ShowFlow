import { test, expect, describe } from 'bun:test';
import { join } from 'node:path';
import { DatabaseManager } from '../db/index';
import { recordGrabbedRelease } from '../db/grabs';
import { parseNewznabFeed, NewznabError } from '../providers/indexers/newznab';
import type { Indexer, IndexerResult, RecentFeed } from '../providers/indexers/types';
import type { ReleaseScore } from './quality_engine';
import { runRssSyncCycle, selectNewReleases, matchReleaseToShow, type RssSource } from './rss_sync';
import { loadRssCursors } from '../db/rss';

const FIX = join(import.meta.dir, '__fixtures__', 'rss');
const read = (f: string) => Bun.file(join(FIX, f)).text();
const HOUR = 3_600_000;

describe('newznab/torznab parsing', () => {
  test('newznab feed', async () => {
    const items = parseNewznabFeed(await read('newznab.xml'), { indexerId: 5, indexerName: 'NZBGeek' });
    expect(items).toHaveLength(3);
    const a = items[0]!;
    expect(a.title).toBe('Due.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP');
    expect(a.guid).toBe('https://api.example/details/aaa111');
    expect(a.downloadUrl).toBe('http://prowlarr:9696/5/download?apikey=x&link=aaa111');
    expect(a.size).toBe(1_500_000_000);
    expect(a.grabs).toBe(12);
    expect(a.categories.map(c => c.id)).toEqual([5000, 5040]);
    expect(a.protocol).toBe('usenet');
    expect(a.publishDate).toBe('2026-10-14T10:00:00.000Z');
    expect(a.indexerId).toBe(5);
    // CDATA title
    expect(items[2]!.title).toBe('Untracked Show S03E07 1080p WEB h264-ETHEL');
    // size falls back to enclosure length
    expect(items[1]!.size).toBe(700_000_000);
  });

  test('torznab feed', async () => {
    const items = parseNewznabFeed(await read('torznab.xml'), { indexerId: 7, indexerName: 'Some Tracker' });
    expect(items).toHaveLength(4);
    const a = items[0]!;
    expect(a.protocol).toBe('torrent');
    expect(a.seeders).toBe(120);
    expect(a.leechers).toBe(30);
    expect(a.size).toBe(4_200_000_000);
    expect(a.infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(a.magnetUrl.startsWith('magnet:?xt=urn:btih:ABCDEF')).toBe(true);
    expect(a.magnetUrl).toContain('&dn=Due+Show');
    expect(items[3]!.categories.map(c => c.id)).toEqual([2040]);
  });

  test('error response throws NewznabError', async () => {
    const xml = await read('error.xml');
    expect(() => parseNewznabFeed(xml, { indexerId: 1, indexerName: 'x' })).toThrow(NewznabError);
  });
});

function rel(title: string, guid: string, publishDate: string): IndexerResult {
  return {
    guid, indexerId: 1, indexerName: 't', title, seeders: 0, leechers: 0, grabs: 0, size: 0,
    publishDate, ageHours: 0, infoUrl: '', downloadUrl: '', magnetUrl: '', infoHash: '',
    protocol: 'torrent', categories: [], indexerFlags: [], isPack: false,
  };
}

describe('cursor', () => {
  const a = rel('A', 'g1', '2026-10-14T10:00:00Z');
  const b = rel('B', 'g2', '2026-10-14T11:00:00Z');
  const c = rel('C', 'g3', '2026-10-14T12:00:00Z');

  test('first pass processes everything, repeat processes nothing', () => {
    const first = selectNewReleases(undefined, [b, a]);
    expect(first.fresh.map(r => r.guid)).toEqual(['g2', 'g1']);
    expect(first.next.lastPubMs).toBe(Date.parse('2026-10-14T11:00:00Z'));
    const again = selectNewReleases(first.next, [b, a]);
    expect(again.fresh).toHaveLength(0);
  });

  test('only items newer than the cursor / unseen are new', () => {
    const first = selectNewReleases(undefined, [b, a]);
    const next = selectNewReleases(first.next, [c, b, a]);
    expect(next.fresh.map(r => r.guid)).toEqual(['g3']);
    // unseen guid but older than the cursor: already scrolled past, skip
    const late = rel('Late', 'g9', '2026-10-14T09:00:00Z');
    expect(selectNewReleases(next.next, [late]).fresh).toHaveLength(0);
    // same pubDate as cursor but new guid: tie, still processed
    const tie = rel('Tie', 'g10', '2026-10-14T12:00:00Z');
    expect(selectNewReleases(next.next, [tie]).fresh.map(r => r.guid)).toEqual(['g10']);
  });

  test('date-less items rely on the guid set', () => {
    const x = rel('X', 'gx', '');
    const first = selectNewReleases(undefined, [x]);
    expect(first.fresh).toHaveLength(1);
    expect(selectNewReleases(first.next, [x]).fresh).toHaveLength(0);
  });

  test('flags a possible gap when the whole page is new', () => {
    const first = selectNewReleases(undefined, [a]);
    expect(selectNewReleases(first.next, [c, b]).possibleGap).toBe(true);
    expect(selectNewReleases(first.next, [b, a]).possibleGap).toBe(false);
  });
});

describe('matching', () => {
  test('standard SxxExx, scene mapping, absolute', () => {
    const show = { id: 's', title: 'Due Show', seriesType: 'standard', profileId: '', allowedIndexers: null, episodes: [{ season: 1, episode: 1 }, { season: 1, episode: 2 }] };
    expect(matchReleaseToShow('Due.Show.S01E02.1080p', show).map(e => e.episode)).toEqual([2]);
    expect(matchReleaseToShow('Other.Show.S01E02.1080p', show)).toEqual([]);
    expect(matchReleaseToShow('Due.Show.S01.1080p.Pack', show)).toEqual([]);

    const anime = { id: 'a', title: 'Honzuki no Gekokujou', seriesType: 'anime', profileId: '', allowedIndexers: null, episodes: [{ season: 1, episode: 58, sceneSeason: 4, sceneEpisode: 22 }] };
    expect(matchReleaseToShow('[Grp] Honzuki no Gekokujou S04E22 [1080p]', anime)).toHaveLength(1);
    expect(matchReleaseToShow('[Grp] Honzuki no Gekokujou S01E22 [1080p]', anime)).toHaveLength(0);

    const abs = { id: 'b', title: 'Dandadan', seriesType: 'absolute', profileId: '', allowedIndexers: null, episodes: [{ season: 1, episode: 12 }, { season: 1, episode: 13 }] };
    expect(matchReleaseToShow('[SubsPlease] Dandadan - 12 (1080p) [ABCD1234].mkv', abs).map(e => e.episode)).toEqual([12]);
  });
});

// ---------- full cycle against an in-memory DB ----------

function seed() {
  const db = new DatabaseManager(':memory:');
  const past = new Date(Date.now() - 48 * HOUR).toISOString();
  db.saveShow({ uuid: 'due', providerId: 'p1', type: 'tmdb', title: 'Due Show', config: {} });
  const ep = (n: number, extra: { filePath?: string; tracked?: boolean } = {}) => {
    db.saveEpisode({ showId: 'due', seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDate: past, ...(extra.filePath ? { filePath: extra.filePath } : {}) });
    db.updateEpisodeAirWindow('due', 1, n, { expectedReleaseAt: past });
    db.setTracked('due', 1, n, extra.tracked ?? true);
  };
  ep(1);                                   // wanted
  ep(2, { filePath: '/media/due/e2.mkv' }); // already on disk
  ep(5);                                   // in-flight (grab recorded below)
  ep(6);                                   // wanted
  ep(7, { tracked: false });               // untracked
  recordGrabbedRelease(db, { showId: 'due', season: 1, episode: 5, releaseTitle: 'Due Show S01E05 720p' });
  return db;
}

const fakeScore = (title: string): ReleaseScore => {
  const t = /2160p/.test(title) ? 3000 : /1080p/.test(title) ? 2000 : /720p/.test(title) ? 1000 : 0;
  return { totalScore: t, rejected: false } as unknown as ReleaseScore;
};

function fakeSource(feeds: () => Promise<RecentFeed[]>): RssSource {
  const indexer: Indexer = {
    name: 'Prowlarr',
    search: async () => [],
    grab: async () => true,
    validate: async () => ({ ok: true }),
    listIndexers: async () => [],
    fetchRecent: feeds,
  };
  return { id: 'prowlarr', indexer };
}

describe('runRssSyncCycle', () => {
  test('grabs best per wanted episode, skips untracked/on-disk/in-flight, never double-processes', async () => {
    const db = seed();
    const nz = parseNewznabFeed(await read('newznab.xml'), { indexerId: 5, indexerName: 'NZBGeek' });
    const tz = parseNewznabFeed(await read('torznab.xml'), { indexerId: 7, indexerName: 'Some Tracker' });
    const source = fakeSource(async () => [
      { key: 'prowlarr:5', name: 'NZBGeek', results: nz },
      { key: 'prowlarr:7', name: 'Some Tracker', results: tz },
    ]);
    const grabs: { title: string; episode: number }[] = [];
    const deps = {
      db,
      sources: [source],
      score: fakeScore,
      grab: async (r: any, ctx: any) => {
        grabs.push({ title: r.title, episode: ctx.episode });
        db.recordGrabbedRelease({ showId: ctx.showId, season: ctx.season, episode: ctx.episode, releaseTitle: r.title });
        return { success: true, message: 'ok' };
      },
    };

    const first = await runRssSyncCycle({} as any, null, deps);
    expect(first.feeds).toBe(2);
    expect(first.newReleases).toBe(7);
    expect(grabs.sort((a, b) => a.episode - b.episode)).toEqual([
      { title: 'Due.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP', episode: 1 }, // 1080p beats 720p
      { title: 'Due Show S01E06 2160p WEB-DL DV HEVC-TOR', episode: 6 },
    ]);
    expect(first.grabbed).toBe(2);

    const cursors = loadRssCursors(db);
    expect(Object.keys(cursors).sort()).toEqual(['prowlarr:5', 'prowlarr:7']);

    // Same feeds again: nothing new, nothing grabbed.
    const second = await runRssSyncCycle({} as any, null, deps);
    expect(second.newReleases).toBe(0);
    expect(second.grabbed).toBe(0);
    expect(grabs).toHaveLength(2);
    db.close();
  });

  test('a release grabbed by RSS is held by the in-flight guard on the next new release', async () => {
    const db = seed();
    let page: IndexerResult[] = [rel('Due Show S01E01 720p HDTV', 'n1', '2026-10-14T10:00:00Z')];
    const grabs: string[] = [];
    const deps = {
      db, score: fakeScore,
      sources: [fakeSource(async () => [{ key: 'k', name: 'feed', results: page }])],
      grab: async (r: any, ctx: any) => {
        grabs.push(r.title);
        db.recordGrabbedRelease({ showId: ctx.showId, season: ctx.season, episode: ctx.episode, releaseTitle: r.title });
        return { success: true, message: 'ok' };
      },
    };
    await runRssSyncCycle({} as any, null, deps);
    page = [rel('Due Show S01E01 1080p WEB-DL', 'n2', '2026-10-14T11:00:00Z'), ...page];
    await runRssSyncCycle({} as any, null, deps);
    expect(grabs).toEqual(['Due Show S01E01 720p HDTV']);
    db.close();
  });

  test('releases rejected by the quality profile are never grabbed', async () => {
    const db = seed();
    const grabs: string[] = [];
    const page = [rel('Due Show S01E01 1080p', 'r1', '2026-10-14T10:00:00Z')];
    const deps = {
      db,
      score: () => ({ totalScore: 0, rejected: true }) as unknown as ReleaseScore,
      sources: [fakeSource(async () => [{ key: 'k', name: 'feed', results: page }])],
      grab: async (r: any) => { grabs.push(r.title); return { success: true, message: 'ok' }; },
    };
    const res = await runRssSyncCycle({} as any, null, deps);
    expect(res.matchedEpisodes).toBe(0);
    expect(grabs).toHaveLength(0);
    db.close();
  });

  test('feed failure is recorded in system health and cleared on recovery', async () => {
    const db = seed();
    let fail = true;
    const deps = {
      db, score: fakeScore,
      sources: [fakeSource(async () => fail
        ? [{ key: 'prowlarr:9', name: 'Broken', results: [], error: 'HTTP 500' }]
        : [{ key: 'prowlarr:9', name: 'Broken', results: [] }])],
      grab: async () => ({ success: true, message: 'ok' }),
    };
    const r1 = await runRssSyncCycle({} as any, null, deps);
    expect(r1.feedErrors).toBe(1);
    let row = db.getHealthSnapshot().byType.indexer.find(r => r.component_id === 'rss:prowlarr:9');
    expect(row?.status).toBe('degraded');
    expect(row?.reason_code).toBe('INDEXER_SEARCH_ERROR');

    fail = false;
    await runRssSyncCycle({} as any, null, deps);
    row = db.getHealthSnapshot().byType.indexer.find(r => r.component_id === 'rss:prowlarr:9');
    expect(row).toBeUndefined();
    db.close();
  });

  test('a source whose fetchRecent throws does not stop the cycle', async () => {
    const db = seed();
    const bad = fakeSource(async () => { throw new Error('ECONNREFUSED'); });
    bad.id = 'nyaa';
    const res = await runRssSyncCycle({} as any, null, { db, sources: [bad], score: fakeScore, grab: async () => ({ success: true, message: 'ok' }) });
    expect(res.feedErrors).toBe(1);
    expect(db.getHealthSnapshot().byType.indexer.find(r => r.component_id === 'rss:nyaa')?.status).toBe('degraded');
    db.close();
  });

  test('untracked episode releases are ignored', async () => {
    const db = seed();
    const grabs: string[] = [];
    const page = [rel('Due Show S01E07 1080p', 'u1', '2026-10-14T10:00:00Z'), rel('Due Show S01E02 2160p', 'u2', '2026-10-14T10:00:00Z')];
    const res = await runRssSyncCycle({} as any, null, {
      db, score: fakeScore,
      sources: [fakeSource(async () => [{ key: 'k', name: 'feed', results: page }])],
      grab: async (r: any) => { grabs.push(r.title); return { success: true, message: 'ok' }; },
    });
    expect(res.newReleases).toBe(2);
    expect(res.matchedEpisodes).toBe(0);
    expect(grabs).toHaveLength(0);
    db.close();
  });

  test('no sources = no-op', async () => {
    const db = seed();
    const res = await runRssSyncCycle({} as any, null, { db, sources: [] });
    expect(res.feeds).toBe(0);
    db.close();
  });
});

describe('runRssSyncCycle: season packs + cutoff upgrades', () => {
  function seedFinishedSeason(withFile = false) {
    const db = new DatabaseManager(':memory:');
    db.saveShow({ uuid: 'pk', providerId: 'p9', type: 'tmdb', title: 'Pack Show', config: {} });
    for (let n = 1; n <= 4; n++) {
      const air = new Date(Date.now() - (60 - n * 7) * 24 * HOUR).toISOString();
      const file = withFile && n === 1 ? { filePath: '/m/pack/e1.mkv' } : {};
      db.saveEpisode({ showId: 'pk', seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDate: air, ...file });
      db.updateEpisodeAirWindow('pk', 1, n, { expectedReleaseAt: air });
      db.setTracked('pk', 1, n, true);
    }
    return db;
  }
  const page = [
    rel('Pack Show S01 1080p WEB-DL x265-GRP', 'pk1', 'Wed 2026-10-14 9:00 PM AEDT (UTC+11:00)'),
    rel('Pack.Show.S01.720p.HDTV', 'pk2', 'Wed 2026-10-14 9:00 PM AEDT (UTC+11:00)'),
    rel('Pack Show S01E02 2160p', 'pk3', 'Wed 2026-10-14 9:00 PM AEDT (UTC+11:00)'),
  ];

  test('a pack for a finished, entirely missing season covers every episode', async () => {
    const db = seedFinishedSeason();
    const grabs: string[] = [];
    const res = await runRssSyncCycle({} as any, null, {
      db, score: fakeScore, upgradeCandidates: () => [],
      sources: [fakeSource(async () => [{ key: 'k', name: 'feed', results: page }])],
      grab: async (r: any, ctx: any) => { grabs.push(`${r.title}|${ctx.episode ?? 'season'}`); return { success: true, message: 'ok' }; },
    });
    expect(grabs).toEqual(['Pack Show S01 1080p WEB-DL x265-GRP|season']);
    expect(res.packs).toBe(1);
    expect(res.packEpisodes).toBe(4);
    // per-episode grab + event rows for each covered episode
    for (let n = 1; n <= 4; n++) expect(db.findGrabbedReleaseForShowEpisode('pk', 1, n)?.release_title).toBe('Pack Show S01 1080p WEB-DL x265-GRP');
    db.close();
  });

  test('no pack when part of the season is already on disk; episodes still match', async () => {
    const db = seedFinishedSeason(true);
    const grabs: string[] = [];
    await runRssSyncCycle({} as any, null, {
      db, score: fakeScore, upgradeCandidates: () => [],
      sources: [fakeSource(async () => [{ key: 'k', name: 'feed', results: page }])],
      grab: async (r: any, ctx: any) => { grabs.push(`${r.title}|${ctx.episode ?? 'season'}`); return { success: true, message: 'ok' }; },
    });
    expect(grabs).toEqual(['Pack Show S01E02 2160p|2']);
    db.close();
  });

  test('cutoff-unmet episode is grabbed only for a strictly better, new release', async () => {
    const db = seed();
    const upgrade = (existingScore: number) => [{
      showId: 'due', showTitle: 'Due Show', seriesType: 'standard', profile: null, libraryTypeId: null,
      season: 1, episode: 2, filePath: '/media/due/e2.mkv', profileId: 'standard', profileName: 'Standard',
      cutoffName: 'WEBDL-1080p', currentQuality: '720p', existingScore, lastSearchedAt: null, searchAttempts: 0,
    }];
    const items = [
      rel('Due Show S01E02 720p', 'x1', 'Wed 2026-10-14 9:00 PM AEDT (UTC+11:00)'),
      rel('Due Show S01E02 1080p', 'x2', 'Wed 2026-10-14 9:00 PM AEDT (UTC+11:00)'),
    ];
    const grabs: string[] = [];
    const mk = (existingScore: number) => ({
      db, score: fakeScore, upgradeCandidates: () => upgrade(existingScore),
      sources: [fakeSource(async () => [{ key: `k${existingScore}`, name: 'feed', results: items }])],
      grab: async (r: any) => { grabs.push(r.title); return { success: true, message: 'ok' }; },
    });
    const r1 = await runRssSyncCycle({} as any, null, mk(1000));
    expect(grabs).toEqual(['Due Show S01E02 1080p']);
    expect(r1.upgrades).toBe(1);

    // already at 1080p-equivalent: nothing beats it
    const r2 = await runRssSyncCycle({} as any, null, mk(2000));
    expect(r2.upgrades).toBe(0);
    expect(grabs).toHaveLength(1);

    // upgrades off
    const r3 = await runRssSyncCycle({ upgradeUntilCutoff: false } as any, null, mk(500));
    expect(r3.upgrades).toBe(0);
    db.close();
  });
});
