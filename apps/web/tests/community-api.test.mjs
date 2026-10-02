import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const adapter = `export class AMapServerError extends Error {}
export const amapRequest = (...args) => globalThis[Symbol.for('community.test.amap')](...args);`;
const source = readFileSync(
  new URL('../app/api/amap/communities/route.ts', import.meta.url),
  'utf8',
).replace(
  /from ['"]@\/lib\/([^'"]+)['"]/g,
  (_, name) =>
    `from ${JSON.stringify(name === 'amap-server' ? `data:text/javascript,${encodeURIComponent(adapter)}` : new URL(`../lib/${name}.ts`, import.meta.url).href)}`,
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { POST } = await import(
  `data:text/javascript,${encodeURIComponent(compiled)}`
);
const station = { id: 'a', name: '上车站', location: '114.4,30.46' };
const end = { id: 'b', name: '下车站', location: '114.42,30.46' };
const community = { id: 'home', name: '小区', location: '114.399,30.46' };
const anchor = { id: 'company', name: '公司', location: '114.421,30.46' };
const seed = {
  id: 'seed',
  directionId: 'dir',
  station,
  accessStation: end,
  citycode: '027',
  lineId: 'line',
  lineName: '2号线(甲--乙)',
  stops: [station, end],
  transitSeconds: 1000,
  companyWalkSeconds: 300,
};
const calls = [];
let failure = false;
globalThis[Symbol.for('community.test.amap')] = async (path, params) => {
  calls.push({ path, params: Object.fromEntries(params) });
  if (failure) throw new Error('upstream unavailable');
  if (path.includes('/place/'))
    return {
      pois: [
        {
          ...community,
          typecode: '120302',
          distance: '100',
          address: ['住宅地址'],
        },
        { ...community, id: 'office', typecode: '120201' },
        { ...community, id: 'gate', typecode: '190000' },
      ],
    };
  return {
    route: {
      transits: [
        {
          cost: { duration: '2000' },
          segments: [
            {
              walking: { duration: '400', distance: '300' },
              bus: {
                buslines: [
                  {
                    id: seed.lineId,
                    name: seed.lineName,
                    departure_stop: station,
                    arrival_stop: end,
                  },
                ],
              },
            },
            { walking: { duration: '300', distance: '200' } },
          ],
        },
      ],
    },
  };
};
async function post(body) {
  return POST(
    new Request('http://localhost/api/amap/communities', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}
test('community API filters residential POIs, paginates, reuses search, verifies full origins and invalidates cache by conditions', async () => {
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) =>
    realTimeout(callback, 0, ...args);
  try {
    for (const invalid of [
      null,
      { action: 'search', station, seedIds: ['a'], radius: 99999 },
      { action: 'search', station, seedIds: ['a'], radius: 500, page: 4 },
    ])
      assert.equal((await post(invalid)).status, 400);
    const search = {
      action: 'search',
      station,
      seedIds: ['seed'],
      radius: 500,
      page: 1,
    };
    let result = await (await post(search)).json();
    assert.deepEqual(
      result.communities.map((item) => item.id),
      ['home'],
    );
    assert.equal(calls.at(-1).params.types, '120302');
    assert.equal(calls.at(-1).params.page_num, '1');
    const count = calls.length;
    result = await (await post({ ...search, seedIds: ['another'] })).json();
    assert.equal(result.cached, true);
    assert.equal(calls.length, count);
    assert.deepEqual(result.communities[0].seedIds, ['another']);
    await post({ ...search, page: 2 });
    assert.equal(calls.at(-1).params.page_num, '2');
    const verify = {
      action: 'verify',
      community,
      seed,
      anchor,
      budgetMinutes: 35,
      departureDate: '2026-10-03',
      departureTime: '08:30',
    };
    result = await (await post(verify)).json();
    assert.equal(result.status, 'reachable');
    assert.equal(result.totalSeconds, 2000);
    assert.equal(calls.at(-1).params.origin, community.location);
    assert.equal(calls.at(-1).params.destination, anchor.location);
    assert.equal(calls.at(-1).params.time, '08-30');
    const after = calls.length;
    result = await (await post(verify)).json();
    assert.equal(result.cached, true);
    assert.equal(calls.length, after);
    result = await (await post({ ...verify, budgetMinutes: 30 })).json();
    assert.equal(result.status, 'over_budget');
    assert.equal(calls.length, after + 1);
    await post({ ...verify, departureTime: '09:30' });
    assert.equal(calls.at(-1).params.time, '09-30');
    failure = true;
    result = await (await post({ ...verify, refresh: true })).json();
    assert.equal(result.status, 'error');
    assert.equal(result.totalSeconds, undefined);
    failure = false;
    result = await (await post({ ...verify, refresh: true })).json();
    assert.equal(result.status, 'reachable');
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});
