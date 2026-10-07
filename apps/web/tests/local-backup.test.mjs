import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportLocalBackup,
  parseLocalBackup,
  mergeBackupCollection,
  BACKUP_MAX_BYTES,
} from '../lib/local-backup.ts';
import {
  emptyCollection,
  makeFavorite,
  currentFavoriteProof,
  communityChoiceKey,
} from '../lib/community-collection.ts';
const a = { id: 'a', name: '上车', location: '114.4,30.4' },
  b = { id: 'b', name: '下车', location: '114.5,30.5' };
const anchor = { id: 'c', name: '公司', location: '114.51,30.51' };
const seed = {
  id: 's',
  directionId: 'd',
  station: a,
  accessStation: b,
  stops: [a, b],
  citycode: '027',
  lineId: 'l',
  lineName: '2号线',
  directionLabel: '开往乙',
  transitSeconds: 100,
  companyWalkSeconds: 100,
};
const home = {
  id: 'h',
  name: '小区',
  location: '114.39,30.39',
  address: '地址',
  distanceMeters: 100,
  seedIds: ['s'],
};
const proof = {
  communityId: 'h',
  seedId: 's',
  checkedAt: Date.now(),
  cached: false,
  status: 'reachable',
  geometry: [{ secret: 'GEOMETRY_NOT_EXPORTED' }],
  totalSeconds: 600,
  homeWalkSeconds: 100,
  companyWalkSeconds: 100,
  transitSeconds: 400,
  message: 'PRIVATE_ERROR_NOT_EXPORTED',
};
const f = () => makeFavorite(home, anchor, seed, '2099-01-01', '08:30', proof);
const place = {
  ...anchor,
  district: '武汉',
  adcode: '420100',
  address: '测试地址',
  typecode: '120100',
};
const planner = {
  preferences: {
    selectedPlace: place,
    budget: 30,
    departureDate: '2099-01-01',
    departureTime: '08:30',
    stationRadius: 500,
    selectedStationIds: ['a'],
    selectedLineKeys: ['a::2号线'],
  },
  recentPlaces: [place],
};
test('backup whitelists user records only; import preserves times and invalidates imported proof', () => {
  const collection = {
    ...emptyCollection(),
    favorites: [
      { ...f(), secret: 'SECRET_KEY_NOT_EXPORTED', verification: proof },
    ],
    ignored: [communityChoiceKey(anchor, home)],
  };
  const raw = exportLocalBackup(
    { ...planner, apiKey: 'SECRET_KEY_NOT_EXPORTED' },
    collection,
  );
  assert.doesNotMatch(
    raw,
    /SECRET_KEY_NOT_EXPORTED|GEOMETRY_NOT_EXPORTED|PRIVATE_ERROR_NOT_EXPORTED|"geometry"/,
  );
  const imported = parseLocalBackup(raw);
  assert.equal(
    imported.collection.favorites[0].verification.checkedAt,
    proof.checkedAt,
  );
  assert.equal(imported.collection.favorites[0].imported, true);
  assert.equal(
    currentFavoriteProof(
      imported.collection.favorites[0],
      anchor,
      '2099-01-01',
      '08:30',
    ),
    false,
  );
  assert.deepEqual(imported.collection.favorites[0].seed, seed);
  assert.deepEqual(imported.planner, planner);
});
test('import is bounded, schema checked and never overwrites existing favorite conflicts', () => {
  const incoming = parseLocalBackup(
    exportLocalBackup(planner, { ...emptyCollection(), favorites: [f()] }),
  );
  const existing = { ...f(), date: '2099-02-01' };
  const merged = mergeBackupCollection(
    { ...emptyCollection(), favorites: [existing] },
    incoming.collection,
  );
  assert.equal(merged.favorites.length, 1);
  assert.equal(merged.favorites[0], existing);
  const full = {
    ...emptyCollection(),
    favorites: Array.from({ length: 20 }, (_, i) => ({
      ...f(),
      id: String(i),
    })),
  };
  assert.throws(() => mergeBackupCollection(full, incoming.collection), /上限/);
  for (const raw of [
    '{bad',
    '{}',
    JSON.stringify({ ...incoming, version: 2 }),
    JSON.stringify({
      ...incoming,
      planner: {
        ...planner,
        preferences: { ...planner.preferences, departureDate: '2026-02-30' },
      },
    }),
    JSON.stringify({
      ...incoming,
      collection: {
        ...incoming.collection,
        favorites: [{ ...f(), community: { ...home, location: 'secret' } }],
      },
    }),
  ])
    assert.throws(() => parseLocalBackup(raw), /格式/);
  assert.throws(
    () => parseLocalBackup('x'.repeat(BACKUP_MAX_BYTES + 1)),
    /1 MB/,
  );
});
