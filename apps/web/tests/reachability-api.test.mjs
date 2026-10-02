import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real POST handler with deterministic upstream replies. Only
// AMap I/O is replaced; request validation, line matching and caches are real.
const adapter = `
export class AMapServerError extends Error {
  constructor(message, code, statusCode) { super(message); this.code = code; this.statusCode = statusCode; }
}
export const amapRequest = (...args) => globalThis[Symbol.for('commute.test.amap')](...args);
export const amapErrorResponse = (error) => Response.json({error:{message:error.message}}, {status:500});
`;
const source = readFileSync(
  new URL('../app/api/amap/reachability/route.ts', import.meta.url),
  'utf8',
).replace(
  /from ['"]@\/lib\/([^'"]+)['"]/g,
  (_, name) =>
    `from ${JSON.stringify(
      name === 'amap-server'
        ? `data:text/javascript,${encodeURIComponent(adapter)}`
        : new URL(`../lib/${name}.ts`, import.meta.url).href,
    )}`,
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

const lines = new Map();
const stopsById = new Map();
for (const name of ['2号线', '12号线', '7路', '8路', '9路']) {
  const stops = Array.from({ length: 25 }, (_, index) => {
    const offset = index - 12;
    const stop = {
      id: `${name}:${offset}`,
      name: `${name}站${offset}`,
      location: `${(114.4 + offset * 0.002).toFixed(6)},30.460000`,
    };
    stopsById.set(stop.id, { stop, name, offset });
    return stop;
  });
  lines.set(
    name,
    [false, true].map((reverse) => ({
      id: `${name}-${reverse ? 'reverse' : 'forward'}`,
      name: `${name}(${reverse ? '乙--甲' : '甲--乙'})`,
      citycode: '027',
      start_stop: reverse ? '乙' : '甲',
      end_stop: reverse ? '甲' : '乙',
      busstops: reverse ? stops.toReversed() : stops,
    })),
  );
}
const calls = [];
let failure = false;
globalThis[Symbol.for('commute.test.amap')] = async (path, params) => {
  calls.push({
    path,
    origin: params.get('originpoi'),
    destination: params.get('destinationpoi'),
  });
  if (path.includes('walking'))
    return {
      route: { paths: [{ distance: '300', cost: { duration: '300' } }] },
    };
  if (path.includes('linename'))
    return { buslines: lines.get(params.get('keywords')) ?? [] };
  const { stop, name, offset } = stopsById.get(params.get('originpoi'));
  if (failure && offset === -12) throw new Error('simulated timeout');
  const line = lines.get(name)[offset > 0 ? 1 : 0];
  const alight = line.busstops.find((item) => item.id === `${name}:0`);
  const start = line.busstops.indexOf(stop);
  const end = line.busstops.indexOf(alight);
  const scopeId = (item) => ({ ...item, id: `route-scoped:${item.id}` });
  const busline = {
    id: line.id,
    name: line.name,
    departure_stop: scopeId(stop),
    arrival_stop: scopeId(alight),
    via_stops: line.busstops.slice(start + 1, end).map(scopeId),
    polyline: `${stop.location};${alight.location}`,
  };
  const direct = {
    cost: { duration: String(Math.abs(offset) * 300) },
    segments: [{ bus: { buslines: [busline] } }],
  };
  return {
    route: {
      transits: [
        {
          cost: { duration: '1' },
          segments: [
            {
              bus: {
                buslines: [
                  { ...busline, id: 'wrong-direction', name: '12号线(甲--乙)' },
                ],
              },
            },
          ],
        },
        {
          cost: { duration: '1' },
          segments: [...direct.segments, ...direct.segments],
        },
        direct,
      ],
    },
  };
};
const station = (id, names) => ({
  id,
  name: id,
  location: '114.400000,30.460000',
  citycode: '027',
  distanceMeters: 300,
  availableLines: names,
  allowedLines: names,
});
const body = {
  anchor: { id: 'company', name: '工作地点', location: '114.400000,30.462000' },
  budgetMinutes: 35,
  departureDate: '2026-10-03',
  departureTime: '08:30',
  accessStations: [station('access-a', ['2号线'])],
};
async function post(value) {
  const response = await POST(
    new Request('http://localhost/api/amap/reachability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }),
  );
  assert.equal(response.status, 200);
  return response.json();
}
const summary = (result) =>
  result.directions.to.accessRoutes.flatMap((group) => group.directions);

test('POST preserves independent precision, strict direct routes, reuse, and targeted retry', async () => {
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) =>
    realTimeout(callback, 0, ...args);
  try {
    const alone = await post({ ...body, refresh: true });
    const multiple = await post({
      ...body,
      refresh: true,
      accessStations: [
        station('access-a', ['2号线', '12号线']),
        station('access-b', ['7路', '8路']),
        station('access-c', ['9路']),
      ],
    });
    assert.equal(summary(multiple).length, 10);
    const own = summary(multiple).filter(
      (direction) => direction.lineName === '2号线',
    );
    const withoutTime = (items) =>
      items.map(({ checkedAt: _checkedAt, ...item }) => item);
    assert.deepEqual(withoutTime(own), withoutTime(summary(alone)));
    assert.equal(multiple.directions.to.stations.length, 10);
    const boarding = summary(multiple).flatMap(
      (direction) => direction.boardingStations,
    );
    assert.ok(
      boarding.length > 10,
      'retain verified intermediate stations, not only the farthest',
    );
    for (const candidate of boarding) {
      assert.equal(candidate.station.id, candidate.stops[0].id);
      assert.ok(candidate.stops.length >= 2);
      assert.ok(
        candidate.transitSeconds + candidate.companyWalkSeconds <= 35 * 60,
      );
    }
    for (const route of multiple.directions.to.stations) {
      assert.equal(route.segmentCount, 1);
      assert.equal(
        route.transitDurationMinutes,
        30,
        'reject faster wrong-line and transfer alternatives',
      );
      assert.equal(route.durationMinutes, 35);
    }
    calls.length = 0;
    const reused = await post(body);
    assert.equal(reused.cachedDirectionCount, 2);
    assert.equal(reused.routeCheckCount, 0);
    assert.equal(calls.length, 0, 'reuse walking, line and direction evidence');
    const grown = await post({ ...body, budgetMinutes: 45 });
    assert.equal(
      calls.length,
      0,
      'known over-budget evidence becomes reachable without API calls',
    );
    assert.ok(
      grown.directions.to.stations.every(
        (route) =>
          route.durationMinutes === 45 && route.routeGeometry.length > 0,
      ),
    );
    assert.deepEqual(
      summary(grown).map((item) => item.checkedAt),
      summary(reused).map((item) => item.checkedAt),
      'reclassification must not renew evidence freshness',
    );
    const shrunk = await post({ ...body, budgetMinutes: 20 });
    assert.ok(
      shrunk.directions.to.stations.every(
        (route) =>
          route.durationMinutes === 20 && route.routeGeometry.length > 0,
      ),
    );
    assert.ok(
      calls.every(
        (call) =>
          call.origin && Math.abs(stopsById.get(call.origin).offset) < 6,
      ),
      'only unknown inner candidates may be queried after shrinking the budget',
    );
    calls.length = 0;
    await post({ ...body, resume: true });
    assert.equal(
      calls.length,
      0,
      'complete directions are not re-queried by supplement action',
    );
    const retried = await post({
      ...body,
      retryDirectionId: summary(alone)[0].id,
    });
    assert.equal(retried.partial, true);
    assert.equal(summary(retried).length, 1);
    assert.equal(summary(retried)[0].boundaryConfirmed, true);
    assert.ok(
      calls.every((call) => call.origin?.startsWith('2号线:-')),
      'only this line direction makes new route calls',
    );

    failure = true;
    const failed = await post({ ...body, refresh: true });
    const pending = summary(failed)[0];
    assert.equal(pending.status, 'reachable');
    assert.equal(pending.boundaryConfirmed, false);
    assert.ok(pending.errorCount > 0);
    assert.ok(pending.evidence.some((item) => item.status === 'error'));
    failure = false;
    calls.length = 0;
    const recovered = await post({ ...body, resume: true });
    assert.ok(
      calls.length > 0 &&
        calls.every(
          (call) =>
            call.origin?.startsWith('2号线:-') &&
            !pending.evidence.some(
              (item) =>
                ['reachable', 'over_budget'].includes(item.status) &&
                item.stationName === stopsById.get(call.origin)?.stop.name,
            ),
        ),
      'global supplement only checks inconclusive or unknown evidence, not confirmed routes/directions',
    );
    assert.equal(summary(recovered)[0].errorCount, 0);
    assert.equal(summary(recovered)[0].boundaryConfirmed, true);

    calls.length = 0;
    await post({ ...body, departureTime: '09:30' });
    assert.ok(
      calls.some((call) => call.path.includes('transit')),
      'changed departure time invalidates route evidence',
    );
    calls.length = 0;
    const oldNow = Date.now;
    const later = oldNow() + 11 * 60_000;
    Date.now = () => later;
    try {
      await post(body);
      assert.ok(
        calls.some((call) => call.path.includes('transit')),
        'expired evidence is not revived by an intervening cache hit',
      );
    } finally {
      Date.now = oldNow;
    }
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});
