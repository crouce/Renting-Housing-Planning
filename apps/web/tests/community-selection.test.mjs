import test from 'node:test';
import assert from 'node:assert/strict';
import {
  walkingStatus,
  selectedVerificationBatch,
  toggleCommunitySelection,
} from '../lib/community-selection.ts';
import {
  addFavorite,
  makeFavorite,
  setIgnored,
  communityChoiceKey,
  parseCollection,
  emptyCollection,
  currentFavoriteProof,
  FAVORITE_LIMIT,
  IGNORED_LIMIT,
  COLLECTION_MAX_BYTES,
} from '../lib/community-collection.ts';

const now = Date.parse('2026-10-07T01:00:00Z');
const proof = {
  communityId: 'p',
  seedId: 's',
  status: 'reachable',
  checkedAt: now,
  cached: false,
  totalSeconds: 1500,
  homeWalkSeconds: 600,
  companyWalkSeconds: 600,
  transitSeconds: 300,
  geometry: [{ path: [[114, 30]], mode: 'WALK', stops: [] }],
};
const limits = { homeMinutes: 10, totalMinutes: 20 };
test('walking preference uses exact seconds and both ends, not rounded text', () => {
  assert.equal(walkingStatus(proof, limits, now), 'match');
  assert.equal(
    walkingStatus({ ...proof, homeWalkSeconds: 601 }, limits, now),
    'over',
  );
  assert.equal(
    walkingStatus({ ...proof, companyWalkSeconds: 601 }, limits, now),
    'over',
  );
  assert.equal(
    walkingStatus(
      { ...proof, homeWalkSeconds: 0, companyWalkSeconds: 0 },
      limits,
      now,
    ),
    'match',
  );
});
test('missing, stale, failed or unmatched evidence is never zero walking', () => {
  for (const value of [
    undefined,
    { ...proof, homeWalkSeconds: undefined },
    { ...proof, companyWalkSeconds: undefined },
    { ...proof, status: 'error' },
    { ...proof, status: 'no_route' },
    { ...proof, checkedAt: now - 600000 },
    { ...proof, checkedAt: now + 1 },
  ]) {
    assert.equal(walkingStatus(value, limits, now), 'pending');
  }
  assert.equal(
    walkingStatus(
      { ...proof, companyWalkSeconds: undefined },
      { homeMinutes: 10, totalMinutes: 0 },
      now,
    ),
    'match',
  );
  assert.equal(
    walkingStatus(undefined, { homeMinutes: 0, totalMinutes: 0 }, now),
    'unlimited',
  );
});
test('only explicitly selected visible pending POIs enter a batch, capped at five', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
  assert.deepEqual(
    selectedVerificationBatch(items, [], () => true),
    [],
  );
  assert.deepEqual(
    selectedVerificationBatch(
      items,
      ['0', '1', '2'],
      (item) => item.id !== '1',
    ).map((item) => item.id),
    ['0', '2'],
  );
  assert.deepEqual(
    selectedVerificationBatch(items.slice(2), ['0', '2'], () => true).map(
      (item) => item.id,
    ),
    ['2'],
    'hidden or excluded selections cannot consume API calls',
  );
  assert.equal(
    selectedVerificationBatch(
      items,
      items.map((item) => item.id),
      () => true,
    ).length,
    5,
  );
  assert.deepEqual(
    toggleCommunitySelection(['0', '1', '2', '3', '4'], '5', true),
    ['0', '1', '2', '3', '4'],
  );
  assert.deepEqual(toggleCommunitySelection(['0', '1'], '0', false), ['1']);
});
const anchor = { id: 'work', name: '公司', location: '114.4,30.4' };
const community = {
  id: 'p',
  name: '小区',
  location: '114.41,30.41',
  address: '测试地址',
  distanceMeters: 200,
  seedIds: ['s'],
};
const seed = {
  id: 's',
  station: { name: '上车' },
  stops: [{ name: '下车' }],
  accessStation: { name: '接驳' },
  lineName: '2号线',
  directionLabel: '开往甲',
};
const favorite = () =>
  makeFavorite(community, anchor, seed, '2026-10-07', '08:30', proof);
test('favorites are independent compact snapshots, with original verification age retained', () => {
  const item = favorite();
  assert.equal('geometry' in item.verification, false);
  assert.equal(item.verification.checkedAt, now);
  const restored = parseCollection(
    JSON.stringify(addFavorite(emptyCollection(), item)),
  );
  assert.equal(restored.favorites[0].verification.totalSeconds, 1500);
  assert.equal(
    currentFavoriteProof(item, anchor, '2026-10-07', '08:30', now),
    true,
  );
  assert.equal(
    currentFavoriteProof(item, anchor, '2026-10-07', '08:30', now + 600000),
    false,
  );
  assert.equal(
    currentFavoriteProof(item, anchor, '2026-10-07', '09:30', now),
    false,
  );
  assert.equal(
    currentFavoriteProof(
      item,
      { ...anchor, location: '115,31' },
      '2026-10-07',
      '08:30',
      now,
    ),
    false,
  );
});
test('favorites update in place, never silently evict when the count limit is reached', () => {
  let collection = emptyCollection();
  for (let i = 0; i < FAVORITE_LIMIT; i++)
    collection = addFavorite(collection, { ...favorite(), id: String(i) });
  assert.throws(
    () => addFavorite(collection, { ...favorite(), id: 'excess' }),
    /20/,
  );
  const changed = addFavorite(collection, {
    ...favorite(),
    id: '0',
    community: { ...community, name: '更新' },
  });
  assert.equal(changed.favorites.length, 20);
  assert.equal(changed.favorites[0].community.name, '更新');
  assert.throws(
    () =>
      addFavorite(emptyCollection(), {
        ...favorite(),
        community: { ...community, name: 'x'.repeat(COLLECTION_MAX_BYTES) },
      }),
    /空间不足/,
  );
});
test('temporarily ignored communities are company scoped and reversible without deleting favorites', () => {
  let collection = addFavorite(emptyCollection(), favorite());
  const id = communityChoiceKey(anchor, community);
  collection = setIgnored(collection, id, true);
  assert.equal(collection.favorites.length, 1);
  assert.notEqual(
    id,
    communityChoiceKey({ ...anchor, id: 'other' }, community),
  );
  collection = setIgnored(collection, id, false);
  assert.deepEqual(collection.ignored, []);
  for (let i = 0; i < IGNORED_LIMIT; i++)
    collection = setIgnored(collection, String(i), true);
  assert.throws(() => setIgnored(collection, 'overflow', true), /100/);
  assert.throws(
    () => setIgnored(emptyCollection(), 'x'.repeat(COLLECTION_MAX_BYTES), true),
    /空间不足/,
  );
});
test('corrupt and oversized local collections fail safely', () => {
  for (const value of [
    null,
    '{broken',
    '{}',
    JSON.stringify({
      version: 1,
      favorites: [null, {}],
      ignored: ['a', null, 'a'],
    }),
    'x'.repeat(COLLECTION_MAX_BYTES),
  ]) {
    const parsed = parseCollection(value);
    assert.deepEqual(parsed.favorites, []);
    assert.ok(parsed.ignored.length <= 1);
  }
});
