import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparisonTask,
  comparisonWinners,
  runComparison,
} from '../lib/commute-comparison.ts';
const home = {
  id: 'h',
  name: '家',
  location: '114.4,30.4',
  seedIds: [],
  address: '',
  distanceMeters: 0,
};
const anchor = { id: 'a', name: '公司', location: '114.5,30.5' };
const seed = {
  id: 's',
  directionId: 'd',
  station: home,
  accessStation: anchor,
  stops: [home, anchor],
  citycode: '027',
  lineId: 'l',
  lineName: '线路',
  directionLabel: '向北',
  transitSeconds: 100,
  companyWalkSeconds: 10,
};
const first = comparisonTask(home, anchor, seed, '2099-01-01', '08:30');
const second = comparisonTask(
  home,
  anchor,
  { ...seed, id: 's2', lineId: 'l2' },
  '2099-01-01',
  '08:30',
);
const good = (totalSeconds = 500, walk = 100) => ({
  communityId: 'h',
  seedId: 's',
  status: 'reachable',
  totalSeconds,
  homeWalkSeconds: walk,
  companyWalkSeconds: walk,
  checkedAt: Date.now(),
  cached: false,
  geometry: [],
});
test('comparison executes only selected distinct tasks, reuses fresh exact proof and retains independent outcomes', async () => {
  const got = [],
    calls = [];
  const count = await runComparison(
    [first, second],
    30,
    new AbortController().signal,
    { [first.key]: good() },
    (t, r) => got.push([t.key, r]),
    async (t) => {
      calls.push(t.key);
      return good(600, 50);
    },
  );
  assert.deepEqual(count, { requested: 1, reused: 1, failed: 0 });
  assert.deepEqual(calls, [second.key]);
  assert.equal(got.length, 2);
  await assert.rejects(
    runComparison(
      [first, first],
      30,
      new AbortController().signal,
      {},
      () => {},
      async () => good(),
    ),
    /不同/,
  );
  await assert.rejects(
    runComparison(
      [first, second, first, second],
      30,
      new AbortController().signal,
      {},
      () => {},
      async () => good(),
    ),
    /2～3/,
  );
});
test('stopping prevents later requests and late writes; one failed route does not erase another', async () => {
  const abort = new AbortController();
  let writes = 0,
    calls = 0;
  await runComparison(
    [first, second],
    30,
    abort.signal,
    {},
    () => writes++,
    async () => {
      calls++;
      abort.abort();
      return good();
    },
  );
  assert.equal(calls, 1);
  assert.equal(writes, 0);
  const got = [];
  const count = await runComparison(
    [first, second],
    30,
    new AbortController().signal,
    {},
    (t, r) => got.push(r),
    async (t) => {
      if (t === first) throw new Error('offline');
      return good();
    },
  );
  assert.equal(count.failed, 1);
  assert.deepEqual(
    got.map((r) => r.status),
    ['error', 'reachable'],
  );
});
test('rankings compare raw seconds, exclude expired/error evidence and never turn missing walks into zero', () => {
  const a = good(300, 100),
    b = good(400, 50),
    missing = { ...good(500), homeWalkSeconds: undefined },
    expired = { ...good(10, 0), checkedAt: Date.now() - 600001 };
  const winners = comparisonWinners([
    { key: 'a', result: a },
    { key: 'b', result: b },
    { key: 'm', result: missing },
    { key: 'old', result: expired },
  ]);
  assert.deepEqual(winners.fastest, ['a']);
  assert.deepEqual(winners.leastWalking, ['b']);
});
