import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchDirection,
  matchesDirectLine,
  normalizeLineName,
  BoundedCache,
} from '../lib/reachability-core.ts';
import { mergeDirectionResult } from '../lib/merge-direction-result.ts';
import { formatDuration } from '../lib/duration.ts';

test('duration breakdown preserves seconds around the budget boundary', () => {
  assert.equal(formatDuration(638), '10 分 38 秒');
  assert.equal(formatDuration(2100 - 638), '24 分 22 秒');
  assert.equal(formatDuration(1453), '24 分 13 秒');
  assert.equal(formatDuration(2100), '35 分钟');
});

const check = (boundary) => async (index) => ({
  status: index <= boundary ? 'reachable' : 'over_budget',
  route: index <= boundary ? { name: `stop-${index}` } : undefined,
});

test('each direction uses identical evidence alone and alongside other directions', async () => {
  const single = await searchDirection({ count: 35, check: check(6) });
  const grouped = await Promise.all(
    [2, 14, 6, 25, 4, 8, 7, 1, 20].map((boundary) =>
      searchDirection({ count: 35, check: check(boundary) }),
    ),
  );
  assert.deepEqual(grouped[2], single);
  assert.equal(single.best.index, 6);
  assert.equal(single.confirmed, false);
});

test('resuming audits farther stops without requesting confirmed evidence again', async () => {
  let state;
  const checked = new Set();
  for (let round = 0; round < 10; round++) {
    state = await searchDirection({
      count: 35,
      previous: state?.observations,
      check: async (index) => {
        assert.equal(checked.has(index), false);
        checked.add(index);
        return check(6)(index);
      },
    });
    if (state.confirmed) break;
  }
  assert.equal(state.confirmed, true);
  assert.equal(state.best.index, 6);
});

test('a nonmonotonic timetable cannot produce a falsely confirmed inner boundary', async () => {
  const state = await searchDirection({
    count: 10,
    limit: 20,
    check: async (index) => ({
      status: [0, 1, 7].includes(index) ? 'reachable' : 'over_budget',
      route: { index },
    }),
  });
  assert.equal(state.best.index, 7);
  assert.equal(state.confirmed, true);
});

test('failed outer stops keep a reachable inner result pending; targeted retry recovers', async () => {
  const first = await searchDirection({
    count: 5,
    check: async (index) =>
      index === 4 ? { status: 'error', errorCode: 'TIMEOUT' } : check(2)(index),
  });
  assert.equal(first.best.index, 2);
  assert.equal(first.confirmed, false);
  const retried = [];
  const next = await searchDirection({
    count: 5,
    previous: first.observations,
    check: async (index) => {
      retried.push(index);
      return check(2)(index);
    },
  });
  assert.deepEqual(retried, [4]);
  assert.equal(next.confirmed, true);
});

test('no direct route, API error, and confirmed over-budget are distinct', async () => {
  for (const status of ['no_route', 'error', 'over_budget']) {
    const result = await searchDirection({
      count: 4,
      check: async () => ({ status }),
    });
    assert.equal(result.status, status);
    assert.equal(result.confirmed, status === 'over_budget');
  }
  assert.equal(
    (await searchDirection({ count: 0, check: check(0) })).status,
    'no_candidate',
  );
});

const stops = [0, 1, 2].map((index) => ({
  id: `s${index}`,
  name: `站${index}`,
  location: `114.${index}00,30.000`,
}));
const expected = {
  id: 'line-2-east',
  name: '轨道交通2号线(甲--乙)',
  stops,
  boardIndex: 0,
  alightIndex: 2,
};
const validLine = {
  id: expected.id,
  name: expected.name,
  departure_stop: stops[0],
  arrival_stop: stops[2],
  via_stops: [stops[1]],
};

test('matching requires the correct line, direction, exact boarding/alighting stops and ordered via stops', () => {
  assert.equal(normalizeLineName('轨道交通2号线(甲--乙)'), '2号线');
  assert.equal(matchesDirectLine(validLine, expected), true);
  assert.equal(
    matchesDirectLine(
      {
        ...validLine,
        departure_stop: { ...stops[0], id: 'line-scoped-board-id' },
        arrival_stop: { ...stops[2], id: 'line-scoped-alight-id' },
        via_stops: [{ ...stops[1], id: 'line-scoped-via-id' }],
      },
      expected,
    ),
    true,
    'AMap stop IDs differ between line lookup and route planning',
  );
  assert.equal(
    matchesDirectLine(
      {
        ...validLine,
        departure_stop: {
          ...stops[0],
          id: 'other',
          location: '115.000,30.000',
        },
      },
      expected,
    ),
    false,
  );
  assert.equal(
    matchesDirectLine(
      { ...validLine, name: '轨道交通12号线(甲--乙)' },
      expected,
    ),
    false,
  );
  assert.equal(
    matchesDirectLine({ ...validLine, id: 'line-2-west' }, expected),
    false,
  );
  assert.equal(
    matchesDirectLine({ ...validLine, departure_stop: stops[1] }, expected),
    false,
  );
  assert.equal(
    matchesDirectLine({ ...validLine, arrival_stop: stops[1] }, expected),
    false,
  );
  assert.equal(
    matchesDirectLine({ ...validLine, via_stops: [stops[2]] }, expected),
    false,
  );
  assert.equal(
    matchesDirectLine(
      { ...validLine, id: undefined, name: '轨道交通2号线' },
      expected,
    ),
    false,
  );
});

test('cache is count bounded, expires, and rejects oversized entries', () => {
  const cache = new BoundedCache(2, 100);
  cache.set('a', { n: 1 }, 1000);
  cache.set('b', { n: 2 }, 1000);
  cache.get('a');
  cache.set('c', { n: 3 }, 1000);
  assert.equal(cache.get('b'), undefined);
  cache.set('large', 'x'.repeat(100), 1000);
  assert.equal(cache.get('large'), undefined);
  cache.set('expired', {}, -1);
  assert.equal(cache.get('expired'), undefined);
});

test('retry replaces only its direction and preserves all other groups and map routes', () => {
  const direction = (id) => ({
    id,
    candidateCount: 2,
    checkedCount: 2,
    errorCount: 0,
    cached: false,
  });
  const route = (id, access, distance) => ({
    logicalId: `${id}-route`,
    lineDirection: { id },
    accessStation: { id: access },
    straightLineMeters: distance,
    durationMinutes: 20,
  });
  const result = {
    candidateCount: 4,
    expandedLineCount: 2,
    routeCheckCount: 4,
    directions: {
      to: {
        stations: [route('a', 'one', 100)],
        accessRoutes: [
          { accessStationId: 'one', directions: [direction('a')] },
          { accessStationId: 'two', directions: [direction('b')] },
        ],
      },
    },
  };
  const patch = {
    routeCheckCount: 1,
    directions: {
      to: {
        stations: [route('b', 'two', 200)],
        accessRoutes: [
          { accessStationId: 'two', directions: [direction('b')] },
        ],
      },
    },
  };
  const merged = mergeDirectionResult(result, patch);
  assert.equal(merged.directions.to.stations.length, 2);
  assert.equal(merged.directions.to.accessRoutes.length, 2);
  assert.deepEqual(merged.directions.to.accessRoutes[0].routeIds, ['a-route']);
  assert.equal(merged.directions.to.farthest.logicalId, 'b-route');
  const added = mergeDirectionResult(merged, {
    ...patch,
    directions: {
      to: {
        stations: [route('c', 'three', 300)],
        accessRoutes: [
          { accessStationId: 'three', directions: [direction('c')] },
        ],
      },
    },
  });
  assert.equal(
    added.directions.to.accessRoutes.length,
    3,
    'streamed continuation may add a previously unprocessed access station',
  );
  assert.equal(added.directions.to.stations.length, 3);
});
