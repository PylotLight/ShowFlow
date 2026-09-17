import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';
import * as schema from './schema';
import { purgeOldScanLogs, ensureCleanupIndexes } from './system';

function seedEvent(db: DatabaseManager, type: string, timestamp: string) {
  db.drizz.insert(schema.auditLogs).values({
    event_type: type,
    entity_type: 'test',
    message: `${type} at ${timestamp}`,
    timestamp,
  }).run();
}

const OLD = '2020-01-01 00:00:00';
const NOW = new Date().toISOString();

test('purgeOldScanLogs removes only old scan-type rows', () => {
  const db = new DatabaseManager(':memory:');
  ensureCleanupIndexes(db);

  seedEvent(db, 'scan', OLD);
  seedEvent(db, 'scan', OLD);
  seedEvent(db, 'scan', NOW);
  seedEvent(db, 'error', OLD);
  seedEvent(db, 'scheduler', OLD);

  const removed = purgeOldScanLogs(db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  expect(removed).toBe(2);

  const remaining = db.drizz.select().from(schema.auditLogs).all();
  expect(remaining).toHaveLength(3);
  expect(remaining.map(r => `${r.event_type}@${r.timestamp}`).sort()).toEqual([
    `error@${OLD}`,
    `scan@${NOW}`,
    `scheduler@${OLD}`,
  ].sort());

  db.close();
});

test('purgeOldScanLogs honors the chunk limit for looped callers', () => {
  const db = new DatabaseManager(':memory:');
  ensureCleanupIndexes(db);
  for (let i = 0; i < 5; i++) seedEvent(db, 'scan', OLD);

  expect(purgeOldScanLogs(db, NOW, 2)).toBe(2);
  expect(purgeOldScanLogs(db, NOW, 2)).toBe(2);
  expect(purgeOldScanLogs(db, NOW, 2)).toBe(1);
  expect(purgeOldScanLogs(db, NOW, 2)).toBe(0);

  db.close();
});
