import { test, expect, describe } from 'bun:test';
import {
  collectBusy,
  waitForQuiet,
  newMigrations,
  shouldBackupBeforeActivate,
  decideAutoActivate,
  normalizeAutoActivate,
  reconcileAttempt,
  retryDelayMs,
  ATTEMPT_RECONCILE_WINDOW_MS,
  type BusyItem,
  type ActivationAttempt,
} from './update_policy';

describe('collectBusy', () => {
  test('ignores cheap tasks, torbox grabs and non-import states', () => {
    const busy = collectBusy({
      runningTasks: ['update-check', 'health-check', 'scan-library'],
      activeJobs: [
        { id: 'torbox-grab-1', type: 'torbox-grab', label: 'Downloading: X' },
        { id: 'scan', type: 'library-scan', label: 'Library scan' },
        { id: 'upd', type: 'update-download', label: 'Downloading ShowFlow' },
      ],
      processing: [
        { id: 'torbox:1', title: 'Show.S01E01', state: 'downloading' },
        { id: 'blackhole:a', title: 'Show.S01E02.mkv', state: 'importing' },
      ],
    });
    expect(busy.map((b) => b.id)).toEqual(['scan-library', 'scan', 'blackhole:a']);
  });
});

describe('waitForQuiet (drain with timeout)', () => {
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  const item: BusyItem = { kind: 'import', id: 'a', label: 'importing a' };

  test('returns immediately when already idle', async () => {
    const c = fakeClock();
    const r = await waitForQuiet(() => [], { timeoutMs: 60_000, ...c });
    expect(r).toEqual({ quiet: true, waitedMs: 0, busy: [] });
  });

  test('waits until the job finishes', async () => {
    const c = fakeClock();
    const waits: number[] = [];
    const r = await waitForQuiet(() => (c.now() < 5_000 ? [item] : []), {
      timeoutMs: 60_000, pollMs: 1_000, onWait: (_b, w) => waits.push(w), ...c,
    });
    expect(r.quiet).toBe(true);
    expect(r.waitedMs).toBe(5_000);
    expect(waits.length).toBe(5);
  });

  test('gives up at the timeout and reports what is still busy', async () => {
    const c = fakeClock();
    const r = await waitForQuiet(() => [item], { timeoutMs: 10_000, pollMs: 3_000, ...c });
    expect(r.quiet).toBe(false);
    expect(r.waitedMs).toBe(10_000);
    expect(r.busy).toEqual([item]);
  });

  test('zero timeout never sleeps (auto-activate path)', async () => {
    const c = fakeClock();
    const r = await waitForQuiet(() => [item], { timeoutMs: 0, ...c });
    expect(r.quiet).toBe(false);
    expect(r.waitedMs).toBe(0);
  });

  test('a throwing probe counts as idle instead of wedging', async () => {
    const c = fakeClock();
    const r = await waitForQuiet(() => { throw new Error('boom'); }, { timeoutMs: 10_000, ...c });
    expect(r.quiet).toBe(true);
  });
});

describe('backup-before-migrate decision', () => {
  const journal = { entries: [
    { idx: 9, when: 1000, tag: '0009_episode_status' },
    { idx: 10, when: 2000, tag: '0010_artwork_files_on_disk' },
    { idx: 11, when: 3000, tag: '0011_new_thing' },
  ] };

  test('new migrations = journal entries newer than the last applied one', () => {
    expect(newMigrations(journal, 2000)!.map((m) => m.tag)).toEqual(['0011_new_thing']);
    expect(shouldBackupBeforeActivate(newMigrations(journal, 2000))).toBe(true);
  });

  test('same schema → no backup', () => {
    expect(newMigrations(journal, 3000)).toEqual([]);
    expect(shouldBackupBeforeActivate(newMigrations(journal, 3000))).toBe(false);
  });

  test('unreadable journal → unknown → backup to be safe', () => {
    expect(newMigrations(null, 3000)).toBeNull();
    expect(newMigrations({} as any, 3000)).toBeNull();
    expect(shouldBackupBeforeActivate(null)).toBe(true);
  });

  test('fresh DB (nothing applied) → everything is new', () => {
    expect(newMigrations(journal, null)!.length).toBe(3);
  });
});

describe('auto-activate scheduling', () => {
  const pending = { releaseId: 'abc' };
  const at = (h: number) => new Date(2026, 9, 15, h, 10);
  const base = { pending, failedReleaseId: null, busy: [] as BusyItem[], activating: false };

  test('defaults to off', () => {
    expect(normalizeAutoActivate(undefined)).toEqual({ mode: 'off', hour: 4 });
    expect(normalizeAutoActivate('garbage')).toEqual({ mode: 'off', hour: 4 });
    expect(normalizeAutoActivate('{"mode":"window","hour":2}')).toEqual({ mode: 'window', hour: 2 });
    expect(normalizeAutoActivate({ mode: 'window', hour: 99 })).toEqual({ mode: 'window', hour: 4 });
    expect(decideAutoActivate({ ...base, settings: { mode: 'off', hour: 4 }, now: at(4) }).activate).toBe(false);
  });

  test('idle mode activates only when nothing is busy', () => {
    const s = { mode: 'idle' as const, hour: 4 };
    expect(decideAutoActivate({ ...base, settings: s, now: at(14) }).activate).toBe(true);
    const busy = decideAutoActivate({ ...base, settings: s, now: at(14), busy: [{ kind: 'task', id: 'scan-library', label: 'task scan-library' }] });
    expect(busy.activate).toBe(false);
    expect(busy.reason).toContain('scan-library');
  });

  test('window mode only inside the chosen hour', () => {
    const s = { mode: 'window' as const, hour: 3 };
    expect(decideAutoActivate({ ...base, settings: s, now: at(2) }).activate).toBe(false);
    expect(decideAutoActivate({ ...base, settings: s, now: at(3) }).activate).toBe(true);
    expect(decideAutoActivate({ ...base, settings: s, now: at(4) }).activate).toBe(false);
  });

  test('never retries a build that already rolled back, or while activating, or with nothing staged', () => {
    const s = { mode: 'idle' as const, hour: 4 };
    expect(decideAutoActivate({ ...base, settings: s, now: at(1), failedReleaseId: 'abc' }).activate).toBe(false);
    expect(decideAutoActivate({ ...base, settings: s, now: at(1), failedReleaseId: 'older' }).activate).toBe(true);
    expect(decideAutoActivate({ ...base, settings: s, now: at(1), activating: true }).activate).toBe(false);
    expect(decideAutoActivate({ ...base, settings: s, now: at(1), pending: null }).activate).toBe(false);
  });
});

describe('rollback detection on boot', () => {
  const now = Date.parse('2026-10-15T02:00:00Z');
  const attempt: ActivationAttempt = {
    releaseId: 'new', tag: 'v1.2.0', fromReleaseId: 'old', startedAt: new Date(now - 60_000).toISOString(), backupFile: 'showflow-x.db',
  };

  test('booted as the target → activated', () => {
    expect(reconcileAttempt(attempt, 'new', now)!.outcome).toBe('activated');
  });

  test('booted as the old build → supervisor rolled back; message points at the backup', () => {
    const r = reconcileAttempt(attempt, 'old', now)!;
    expect(r.outcome).toBe('rolled-back');
    expect(r.message).toContain('rolled back');
    expect(r.message).toContain('showflow-x.db');
  });

  test('already-reconciled or stale attempts are left alone', () => {
    expect(reconcileAttempt({ ...attempt, outcome: 'activated' }, 'old', now)).toBeNull();
    expect(reconcileAttempt({ ...attempt, startedAt: new Date(now - ATTEMPT_RECONCILE_WINDOW_MS - 1).toISOString() }, 'old', now)).toBeNull();
    expect(reconcileAttempt(null, 'old', now)).toBeNull();
  });
});

test('download retry backoff starts short (CI still uploading) and settles at 15 min', () => {
  expect(retryDelayMs(1)).toBe(60_000);
  expect(retryDelayMs(2)).toBe(120_000);
  expect(retryDelayMs(4)).toBe(600_000);
  expect(retryDelayMs(9)).toBe(15 * 60_000);
});
