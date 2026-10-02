import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCommunities,
  verifyCommunityRoutes,
  validSeed,
  validLocation,
  parsePath,
} from '../lib/community-core.ts';

const stops = [
  { id: 'a', name: '上车站', location: '114.4,30.46' },
  { id: 'b', name: '途中站', location: '114.41,30.46' },
  { id: 'c', name: '下车站', location: '114.42,30.46' },
];
const seed = {
  id: 'seed',
  directionId: 'dir',
  station: stops[0],
  accessStation: stops[2],
  citycode: '027',
  lineId: 'line-2',
  lineName: '轨道交通2号线(甲--乙)',
  directionLabel: '开往乙',
  stops,
  transitSeconds: 1500,
  companyWalkSeconds: 300,
};
const line = {
  id: seed.lineId,
  name: seed.lineName,
  departure_stop: stops[0],
  arrival_stop: stops[2],
  via_stops: [stops[1]],
  polyline: '114.4,30.46;114.41,30.46;114.42,30.46',
};
const plan = (total = 2100) => ({
  cost: { duration: String(total) },
  segments: [
    {
      walking: {
        cost: { duration: '300' },
        distance: '250',
        steps: [{ polyline: '114.399,30.46;114.4,30.46' }],
      },
      bus: { buslines: [line] },
    },
    {
      walking: {
        duration: '300',
        distance: '250',
        steps: [{ polyline: '114.42,30.46;114.421,30.46' }],
      },
    },
  ],
});

test('community merge deduplicates POIs without losing alternative boarding stations', () => {
  const base = {
    id: 'home',
    name: '住宅小区',
    location: '114.4,30.46',
    address: '地址',
    distanceMeters: 400,
    seedIds: ['a'],
  };
  const merged = mergeCommunities(
    [base],
    [{ ...base, distanceMeters: 200, seedIds: ['b', 'a'] }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].distanceMeters, 200);
  assert.deepEqual(merged[0].seedIds, ['a', 'b']);
});
test('door-to-door budget includes both walks exactly once, with second-level boundary', () => {
  const result = verifyCommunityRoutes([plan()], seed, 'home', 2100);
  assert.equal(result.status, 'reachable');
  assert.equal(result.homeWalkSeconds, 300);
  assert.equal(result.transitSeconds, 1500);
  assert.equal(result.companyWalkSeconds, 300);
  assert.equal(result.totalSeconds, 2100);
  assert.equal(
    result.geometry.filter((part) => part.mode === 'WALK').length,
    2,
  );
  assert.equal(result.geometry[1].stops.length, 3);
  assert.equal(
    verifyCommunityRoutes([plan(2101)], seed, 'home', 2100).status,
    'over_budget',
  );
});
test('a reachable station does not make every nearby community reachable', () => {
  assert.ok(seed.transitSeconds + seed.companyWalkSeconds < 2100);
  const route = plan(2400);
  route.segments[0].walking.cost.duration = '600';
  assert.equal(
    verifyCommunityRoutes([route], seed, 'home', 2100).status,
    'over_budget',
  );
});
test('community verification rejects wrong lines, boarding stops, directions and transfers', () => {
  for (const busline of [
    { ...line, id: 'line-reverse' },
    { ...line, name: '轨道交通12号线(甲--乙)' },
    { ...line, departure_stop: stops[1] },
  ]) {
    const route = plan(1200);
    route.segments[0].bus.buslines = [busline];
    assert.equal(
      verifyCommunityRoutes([route], seed, 'home', 2100).status,
      'no_route',
    );
  }
  const transfer = plan();
  transfer.segments.push({ bus: { buslines: [line] } });
  assert.equal(
    verifyCommunityRoutes([transfer], seed, 'home', 2100).status,
    'no_route',
  );
});
test('missing walking detail is not fabricated as zero', () => {
  const route = plan();
  delete route.segments[0].walking.cost;
  const result = verifyCommunityRoutes([route], seed, 'home', 2100);
  assert.equal(result.totalSeconds, 2100);
  assert.equal(result.homeWalkSeconds, undefined);
  assert.equal(result.transitSeconds, undefined);
  assert.match(result.message, /未提供完整/);
});
test('community inputs and geometry reject invalid or non-geographic coordinates', () => {
  assert.ok(validSeed(seed));
  assert.equal(validSeed({ ...seed, stops: [] }), false);
  assert.equal(validSeed(null), false);
  assert.equal(validLocation('999,999'), false);
  assert.deepEqual(parsePath('114.4,30.46;invalid;999,999;114.42,30.46'), [
    [114.4, 30.46],
    [114.42, 30.46],
  ]);
});
