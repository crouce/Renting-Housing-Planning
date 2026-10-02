import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommunity,
  communityRouteKey,
  isRecent,
  replaceStationCommunities,
} from '../lib/cache-policy.ts';

const station = { id: 's', name: '站', location: '114.4,30.4' };
const end = { id: 'e', name: '下车', location: '114.5,30.4' };
const seed = {
  id: 'route',
  station,
  accessStation: end,
  citycode: '027',
  lineId: 'line',
  lineName: '2号线',
  stops: [station, end],
  transitSeconds: 600,
  companyWalkSeconds: 300,
};
const home = {
  id: 'home',
  name: '小区',
  location: '114.39,30.4',
  seedIds: ['route'],
  distanceMeters: 100,
  address: '',
};
const key = (poi = home, route = seed, time = '08:30', anchor = end) =>
  communityRouteKey(poi, anchor, route, '2026-10-03', time);

test('raw community evidence reclassifies at exact seconds without renewing its timestamp', () => {
  const original = {
    status: 'over_budget',
    totalSeconds: 1801,
    checkedAt: 1000,
    geometry: [{}],
  };
  assert.equal(classifyCommunity(original, 1800).status, 'over_budget');
  const reachable = classifyCommunity(original, 1801);
  assert.equal(reachable.status, 'reachable');
  assert.equal(reachable.checkedAt, original.checkedAt);
  assert.equal(reachable.geometry, original.geometry);
  assert.equal(original.status, 'over_budget');
  assert.equal(
    classifyCommunity({ ...original, status: 'error' }, 9999).status,
    'error',
  );
  assert.equal(isRecent(1000, 600999), true);
  assert.equal(isRecent(1000, 601000), false);
});

test('route identity ignores derived budgets/timings, but isolates changed locations, lines and departure time', () => {
  assert.equal(
    key(),
    key(home, { ...seed, transitSeconds: 900, companyWalkSeconds: 500 }),
  );
  assert.notEqual(key(), key({ ...home, location: '114.38,30.4' }));
  assert.notEqual(key(), key(home, { ...seed, lineId: 'other-line' }));
  assert.notEqual(key(), key(home, seed, '09:30'));
  assert.notEqual(
    key(),
    key(home, seed, '08:30', { ...end, location: '114.6,30.4' }),
  );
});

test('station list refresh retains other station results and matching proofs; moved POIs get a new proof key', () => {
  const previous = [home, { ...home, id: 'other', seedIds: ['other-seed'] }];
  const proofs = { [key()]: { totalSeconds: 1801 } };
  const updated = replaceStationCommunities(
    previous,
    [{ ...home, name: '新名称' }],
    ['route'],
  );
  assert.equal(updated.length, 2);
  assert.equal(
    proofs[key(updated.find((item) => item.id === home.id))].totalSeconds,
    1801,
  );
  assert.ok(
    updated.some((item) => item.id === 'other'),
    'unrefreshed or failed station lists are kept',
  );
  const moved = replaceStationCommunities(
    previous,
    [{ ...home, location: '114.38,30.4' }],
    ['route'],
  );
  assert.equal(
    proofs[key(moved.find((item) => item.id === home.id))],
    undefined,
  );
  assert.equal(replaceStationCommunities(previous, [], ['route']).length, 1);
});
