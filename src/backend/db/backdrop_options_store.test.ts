import { test, expect } from 'bun:test';
import { DatabaseManager } from './index';

test('backdrop options round-trip through settings storage', () => {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Show', config: {} });

  expect(db.getShowBackdropOptions('s1')).toEqual([]);

  db.saveShowBackdropOptions('s1', [
    { url: 'https://x/a.jpg', width: 1280, height: 720 },
    { url: 'https://x/b.jpg' },
  ]);
  expect(db.getShowBackdropOptions('s1')).toEqual([
    { url: 'https://x/a.jpg', width: 1280, height: 720 },
    { url: 'https://x/b.jpg' },
  ]);
});

test('backdrop options tolerate corrupt or oversized payloads', () => {
  const db = new DatabaseManager(':memory:');
  db.saveShow({ uuid: 's1', providerId: 'p1', type: 'tmdb', title: 'Show', config: {} });

  db.setSetting('backdropOptions.s1', 'not-json{');
  expect(db.getShowBackdropOptions('s1')).toEqual([]);

  db.setSetting('backdropOptions.s1', JSON.stringify([{ nope: 1 }, { url: 'https://x/ok.jpg' }]));
  expect(db.getShowBackdropOptions('s1')).toEqual([{ url: 'https://x/ok.jpg' }]);

  const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://x/${i}.jpg` }));
  db.saveShowBackdropOptions('s1', many);
  expect(db.getShowBackdropOptions('s1')).toHaveLength(32);
});
