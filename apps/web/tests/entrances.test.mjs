import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEntrance, changeEntrance } from '../lib/entrances.ts';
import {
  emptyCollection,
  setCollectionEntrance,
  makeFavorite,
  currentFavoriteProof,
} from '../lib/community-collection.ts';
import { communityRouteKey } from '../lib/cache-policy.ts';
import { exportLocalBackup, parseLocalBackup } from '../lib/local-backup.ts';
const a = { id: 'a', name: '公司', location: '114.4,30.4' };
const c = {
  id: 'c',
  name: '小区',
  location: '114.5,30.5',
  address: '',
  distanceMeters: 100,
  seedIds: ['s'],
};
const end = { ...a, id: 'b' };
const seed = {
  id: 's',
  directionId: 'd',
  station: c,
  accessStation: end,
  stops: [c, end],
  citycode: '027',
  lineId: 'l',
  lineName: '2号线',
  directionLabel: '开往乙',
  transitSeconds: 10,
  companyWalkSeconds: 10,
};
test('entrance correction preserves original, separates proof keys, restores without drifting, and enforces bounds', () => {
  const entries = changeEntrance([], 'community', c, '114.5001,30.5001');
  const adjusted = applyEntrance(c, 'community', entries);
  assert.equal(adjusted.originalLocation, c.location);
  assert.notEqual(
    communityRouteKey(c, a, seed, '2099-01-01', '08:00'),
    communityRouteKey(adjusted, a, seed, '2099-01-01', '08:00'),
  );
  const again = changeEntrance(
    entries,
    'community',
    adjusted,
    '114.5002,30.5002',
  );
  assert.equal(again[0].originalLocation, c.location);
  const restored = changeEntrance(again, 'community', adjusted, c.location);
  assert.equal(restored.length, 0);
  assert.equal(
    applyEntrance(adjusted, 'community', restored).location,
    c.location,
  );
  assert.throws(() => changeEntrance([], 'community', c, '116,31'));
  assert.throws(() => changeEntrance([], 'community', c, 'NaN,30'));
});
test('entrance updates invalidate affected favorites and survive local backup without rewriting evidence times', () => {
  const f = makeFavorite(c, a, seed, '2099-01-01', '08:00', {
    communityId: 'c',
    seedId: 's',
    checkedAt: Date.now(),
    status: 'reachable',
    totalSeconds: 300,
    geometry: [],
    cached: false,
  });
  const original = { ...emptyCollection(), favorites: [f] };
  const next = setCollectionEntrance(
    original,
    'community',
    c,
    '114.5001,30.5001',
  );
  assert.equal(next.favorites[0].verification, undefined);
  assert.equal(next.favorites[0].community.originalLocation, c.location);
  assert.equal(original.favorites[0].verification.totalSeconds, 300);
  const moved = setCollectionEntrance(next, 'company', a, '114.4001,30.4001');
  assert.notEqual(moved.favorites[0].id, f.id);
  assert.equal(
    currentFavoriteProof(moved.favorites[0], a, '2099-01-01', '08:00'),
    false,
  );
  const roundtrip = parseLocalBackup(exportLocalBackup(null, moved));
  assert.equal(roundtrip.collection.entrances.length, 2);
  assert.equal(
    roundtrip.collection.favorites[0].community.originalLocation,
    c.location,
  );
});
