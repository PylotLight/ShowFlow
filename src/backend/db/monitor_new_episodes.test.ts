import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { DatabaseManager } from './index';
import { shouldAutoTrackNewEpisode, NEW_EPISODE_LOOKBACK_DAYS } from './shows';
import { showRoutes } from '../routes/shows';
import { db as globalDb } from '.';

const DAY = 86_400_000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function tracked(db: DatabaseManager, showId: string, s: number, e: number): number {
  return (db.getEpisode(showId, s, e)?.is_tracked ?? -1) as number;
}

function newShow(db: DatabaseManager, id: string, monitorNewEpisodes?: boolean) {
  db.saveShow({ uuid: id, providerId: `p-${id}`, type: 'tmdb', title: id, config: {}, monitorNewEpisodes });
}

describe('shows.monitor_new_episodes', () => {
  test('defaults on for new shows, explicit false opts out', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 'on');
    newShow(db, 'off', false);
    expect(db.getShow('on').monitor_new_episodes).toBe(1);
    expect(db.getShow('off').monitor_new_episodes).toBe(0);
    // re-save without the flag leaves it alone
    newShow(db, 'off');
    expect(db.getShow('off').monitor_new_episodes).toBe(0);
    db.close();
  });
});

describe('syncEpisodes auto-tracking', () => {
  test('first sync of a monitored show tracks only upcoming/TBA, not the back catalog', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's');
    db.syncEpisodes('s', [
      { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) },
      { seasonNumber: 1, episodeNumber: 2, airDate: isoDate(-3) },
      { seasonNumber: 2, episodeNumber: 1, airDate: isoDate(5) },
      { seasonNumber: 2, episodeNumber: 2 },
    ]);
    expect(tracked(db, 's', 1, 1)).toBe(0);
    expect(tracked(db, 's', 1, 2)).toBe(0);
    expect(tracked(db, 's', 2, 1)).toBe(1);
    expect(tracked(db, 's', 2, 2)).toBe(1);
    db.close();
  });

  test('refresh inserts newly announced episodes tracked when flag on', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's');
    db.syncEpisodes('s', [{ seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) }]);
    db.syncEpisodes('s', [
      { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) },
      { seasonNumber: 1, episodeNumber: 2, airDate: isoDate(-10) }, // aired between syncs
      { seasonNumber: 1, episodeNumber: 3, airDate: isoDate(7) },
      { seasonNumber: 1, episodeNumber: 4 },
      { seasonNumber: 1, episodeNumber: 5, airDate: isoDate(-(NEW_EPISODE_LOOKBACK_DAYS + 30)) }, // old churn
    ]);
    expect(tracked(db, 's', 1, 1)).toBe(0);
    expect(tracked(db, 's', 1, 2)).toBe(1);
    expect(tracked(db, 's', 1, 3)).toBe(1);
    expect(tracked(db, 's', 1, 4)).toBe(1);
    expect(tracked(db, 's', 1, 5)).toBe(0);
    db.close();
  });

  test('flag off leaves new episodes untracked', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's', false);
    db.syncEpisodes('s', [{ seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) }]);
    db.syncEpisodes('s', [{ seasonNumber: 1, episodeNumber: 2, airDate: isoDate(3) }]);
    expect(tracked(db, 's', 1, 2)).toBe(0);
    db.close();
  });

  test('never alters tracking on existing rows', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's');
    db.syncEpisodes('s', [
      { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(3) },
      { seasonNumber: 1, episodeNumber: 2, airDate: isoDate(-400) },
    ]);
    db.setTracked('s', 1, 1, false); // user untracked an upcoming one
    db.setTracked('s', 1, 2, true);
    db.syncEpisodes('s', [
      { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(4) },
      { seasonNumber: 1, episodeNumber: 2, airDate: isoDate(-400) },
    ]);
    expect(tracked(db, 's', 1, 1)).toBe(0);
    expect(tracked(db, 's', 1, 2)).toBe(1);
    // search_mode still gets its default on new rows
    db.syncEpisodes('s', [{ seasonNumber: 1, episodeNumber: 3, airDate: isoDate(2) }]);
    expect(db.getEpisode('s', 1, 3).search_mode).toBe('auto');
    db.close();
  });

  test('specials only auto-track when the show already tracks a special', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 'a');
    newShow(db, 'b');
    for (const id of ['a', 'b']) {
      db.syncEpisodes(id, [
        { seasonNumber: 0, episodeNumber: 1, airDate: isoDate(-400) },
        { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) },
      ]);
    }
    db.setTracked('b', 0, 1, true);
    for (const id of ['a', 'b']) {
      db.syncEpisodes(id, [{ seasonNumber: 0, episodeNumber: 2, airDate: isoDate(5) }]);
    }
    expect(tracked(db, 'a', 0, 2)).toBe(0);
    expect(tracked(db, 'b', 0, 2)).toBe(1);
    db.close();
  });

  test('saveEpisode only auto-tracks when the caller opts in (import path)', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's');
    db.syncEpisodes('s', [{ seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) }]);
    db.saveEpisode({ showId: 's', seasonNumber: 1, episodeNumber: 2, airDate: isoDate(2) });
    db.saveEpisode({ showId: 's', seasonNumber: 1, episodeNumber: 3, filePath: '/x.mkv', autoTrackNew: true });
    db.saveEpisode({ showId: 's', seasonNumber: 1, episodeNumber: 1, filePath: '/y.mkv', autoTrackNew: true });
    expect(tracked(db, 's', 1, 2)).toBe(0);
    expect(tracked(db, 's', 1, 3)).toBe(1);
    expect(tracked(db, 's', 1, 1)).toBe(0); // existing row untouched
    db.close();
  });
});

describe('shouldAutoTrackNewEpisode', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const base = { monitor: true, tracksSpecials: false, initialPopulation: false, now };
  test('rules', () => {
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 1, airDate: '2026-10-20' }, { ...base, monitor: false })).toBe(false);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 1, airDate: '' }, base)).toBe(true);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 1, airDate: '2026-10-01T09:00:00Z' }, base)).toBe(true);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 1, airDate: '2026-10-01' }, { ...base, initialPopulation: true })).toBe(false);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 1, airDate: '2026-10-15' }, { ...base, initialPopulation: true })).toBe(true);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 0, airDate: '2026-10-20' }, base)).toBe(false);
    expect(shouldAutoTrackNewEpisode({ seasonNumber: 0, airDate: '2026-10-20' }, { ...base, tracksSpecials: true })).toBe(true);
  });
});

describe('trackUpcoming', () => {
  test('PATCH-side one-shot tracks existing unaired/TBA episodes only', () => {
    const db = new DatabaseManager(':memory:');
    newShow(db, 's', false);
    db.syncEpisodes('s', [
      { seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-30) },
      { seasonNumber: 1, episodeNumber: 2, airDate: isoDate(6) },
      { seasonNumber: 1, episodeNumber: 3 },
      { seasonNumber: 0, episodeNumber: 1, airDate: isoDate(6) },
    ]);
    db.updateShow('s', { monitorNewEpisodes: true, trackUpcoming: true });
    expect(db.getShow('s').monitor_new_episodes).toBe(1);
    expect(tracked(db, 's', 1, 1)).toBe(0);
    expect(tracked(db, 's', 1, 2)).toBe(1);
    expect(tracked(db, 's', 1, 3)).toBe(1);
    expect(tracked(db, 's', 0, 1)).toBe(0);
    db.close();
  });
});

describe('migration 0007 backfill', () => {
  test('monitors shows that track any episode, not the rest', async () => {
    const db = new DatabaseManager(':memory:');
    const sqlText = await Bun.file(resolve(import.meta.dir, 'migrations/0007_monitor_new_episodes.sql')).text();
    const backfill = sqlText.split('--> statement-breakpoint')[1]!;
    newShow(db, 'any'); newShow(db, 'none'); newShow(db, 'empty');
    db.syncEpisodes('any', [{ seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) }, { seasonNumber: 2, episodeNumber: 1, airDate: isoDate(-300) }]);
    db.syncEpisodes('none', [{ seasonNumber: 1, episodeNumber: 1, airDate: isoDate(-400) }]);
    db.setTracked('any', 1, 1, true);
    db.db.run(backfill);
    expect(db.getShow('any').monitor_new_episodes).toBe(1);
    expect(db.getShow('none').monitor_new_episodes).toBe(0);
    expect(db.getShow('empty').monitor_new_episodes).toBe(0);
    db.close();
  });
});

describe('API', () => {
  const routes = showRoutes(null as any, null as any) as Record<string, any>;
  test('GET exposes monitorNewEpisodes and PATCH toggles it', async () => {
    const id = `monitor-test-${crypto.randomUUID()}`;
    globalDb.saveShow({ uuid: id, providerId: id, type: 'tmdb', title: 'Monitor Test', config: {} });
    try {
      const h = routes['/api/shows/:id'];
      let body = await (await h.GET({ params: { id } } as any)).json();
      expect(body.monitorNewEpisodes).toBe(true);

      const patch = (b: unknown) => h.PATCH({ params: { id }, json: async () => b } as any);
      expect((await patch({ monitorNewEpisodes: false })).status).toBe(200);
      body = await (await h.GET({ params: { id } } as any)).json();
      expect(body.monitorNewEpisodes).toBe(false);

      expect((await patch({ monitorNewEpisodes: 'yes' })).status).toBe(400);

      const list = await (await routes['/api/shows'].GET()).json();
      expect(list.find((s: any) => s.id === id)?.monitorNewEpisodes).toBe(false);
    } finally {
      globalDb.removeShow(id);
    }
  });
});
