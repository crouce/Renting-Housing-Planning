import test from 'node:test';
import assert from 'node:assert/strict';
import { overlappingCommunities, pinLabel } from '../lib/community-map.ts';
test('overlap picker adapts to zoom and retains identical-coordinate POIs', () => {
  const points = [
    { id: 'a', location: '114.4,30.4' },
    { id: 'b', location: '114.4,30.4' },
    { id: 'c', location: '114.4007,30.4' },
    { id: 'd', location: '115,31' },
  ];
  assert.deepEqual(
    overlappingCommunities(points, points[0], 14).map((x) => x.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    overlappingCommunities(points, points[0], 19).map((x) => x.id),
    ['a', 'b'],
  );
});
test('pin label distinguishes budget state and independent favorite state', () => {
  assert.equal(pinLabel(), '待核验');
  assert.equal(
    pinLabel({ status: 'over_budget', favorite: true }),
    '已收藏 · 超预算',
  );
  assert.equal(pinLabel({ status: 'reachable', favorite: false }), '预算内');
});
