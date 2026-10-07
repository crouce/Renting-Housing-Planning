import test from 'node:test';
import assert from 'node:assert/strict';
import { favoriteSeed, favoriteRecheckIssue } from '../lib/favorite-recheck.ts';
import {
  makeFavorite,
  currentFavoriteProof,
} from '../lib/community-collection.ts';
const station = { id: 'a', name: '上车', location: '114.4,30.4' };
const end = { id: 'b', name: '下车', location: '114.5,30.5' };
const seed = {
  id: 's',
  directionId: 'd',
  station,
  accessStation: end,
  stops: [station, end],
  citycode: '027',
  lineId: 'l',
  lineName: '2号线',
  directionLabel: '开往乙',
  transitSeconds: 100,
  companyWalkSeconds: 100,
};
const anchor = { id: 'c', name: '公司', location: '114.51,30.51' };
const item = makeFavorite(
  {
    id: 'h',
    name: '小区',
    location: '114.39,30.39',
    address: '',
    distanceMeters: 10,
    seedIds: ['s'],
  },
  anchor,
  seed,
  '2099-01-01',
  '08:30',
);
test('favorite retains exact recheck inputs, with no guess for old or ambiguous records', () => {
  assert.deepEqual(favoriteSeed(item, []), seed);
  const old = { ...item, seed: undefined };
  assert.equal(favoriteSeed(old, []), undefined);
  assert.deepEqual(favoriteSeed(old, [seed]), seed);
  assert.equal(favoriteSeed(old, [seed, { ...seed, id: 'other' }]), undefined);
  assert.equal(
    favoriteSeed(old, [{ ...seed, directionLabel: '开往甲' }]),
    undefined,
  );
});
test('recheck prevents wrong company, stale dates and missing direction data; imported proof never becomes fresh', () => {
  assert.equal(
    favoriteRecheckIssue(item, anchor, '2099-01-01', '08:30', []),
    '',
  );
  assert.match(
    favoriteRecheckIssue(
      item,
      { ...anchor, location: '115,31' },
      '2099-01-01',
      '08:30',
      [],
    ),
    /工作地点/,
  );
  assert.match(
    favoriteRecheckIssue(item, anchor, '2020-01-01', '08:30', []),
    /日期/,
  );
  assert.match(
    favoriteRecheckIssue(
      { ...item, seed: undefined },
      anchor,
      '2099-01-01',
      '08:30',
      [],
    ),
    /旧收藏/,
  );
  const fresh = {
    ...item,
    verification: {
      checkedAt: Date.now(),
      status: 'reachable',
      totalSeconds: 10,
    },
  };
  assert.equal(
    currentFavoriteProof(fresh, anchor, '2099-01-01', '08:30'),
    true,
  );
  assert.equal(
    currentFavoriteProof(
      { ...fresh, imported: true },
      anchor,
      '2099-01-01',
      '08:30',
    ),
    false,
  );
});
