import test from 'node:test';
import assert from 'node:assert/strict';
import { chinaDate, validDepartureDate } from '../lib/departure-date.ts';
import { readCalculationStream } from '../lib/calculation-stream.ts';
import {
  captureViewport,
  restoreViewport,
  visibleMapRoutes,
} from '../lib/map-view.ts';

test('China calendar date, explicit confirmation and invalid calendar dates', () => {
  const now = Date.parse('2026-10-07T15:59:59Z');
  assert.equal(chinaDate(now), '2026-10-07');
  assert.equal(chinaDate(now + 1000), '2026-10-08');
  assert.equal(chinaDate(now, 1), '2026-10-08');
  assert.equal(validDepartureDate('2026-10-06', '2026-10-07'), false);
  assert.equal(validDepartureDate('2026-10-07', '2026-10-07'), true);
  assert.equal(validDepartureDate('2027-02-29', '2026-10-07'), false);
  assert.equal(validDepartureDate('2028-02-29', '2026-10-07'), true);
  assert.equal(validDepartureDate('', '2026-10-07'), false);
});

const stream = (events, terminate = true) => {
  const bytes = new TextEncoder().encode(
    events.map(JSON.stringify).join('\n') + '\n',
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split every UTF-8 codepoint and JSON object across network chunks.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        if (terminate) controller.close();
      },
    }),
  );
};
test('NDJSON delivers real progress and partial results across arbitrary UTF-8 chunks', async () => {
  const expected = [
    {
      type: 'progress',
      progress: { label: '接驳步行 · 金融港北', completedDirections: 0 },
    },
    { type: 'snapshot', result: { incomplete: true, stations: ['甲'] } },
    { type: 'result', result: { incomplete: false, stations: ['甲', '乙'] } },
  ];
  const actual = [];
  await readCalculationStream(
    stream(expected),
    (event) => actual.push(event),
    new AbortController().signal,
  );
  assert.deepEqual(actual, expected);
});
test('interruption and server errors preserve already delivered snapshots', async () => {
  const actual = [];
  await assert.rejects(
    readCalculationStream(
      stream([{ type: 'snapshot', result: 1 }]),
      (event) => actual.push(event),
      new AbortController().signal,
    ),
    /中断/,
  );
  assert.equal(actual.length, 1);
  await assert.rejects(
    readCalculationStream(
      stream([{ type: 'error', message: '日期已过期' }]),
      () => {},
      new AbortController().signal,
    ),
    /日期已过期/,
  );
});
test('stop cancels the body, not just hides the progress', async () => {
  const control = new AbortController();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const reading = readCalculationStream(response, () => {}, control.signal);
  control.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
test('each map view retains an independent copied camera and route selection has no I/O', () => {
  let center = [114.4, 30.4],
    zoom = 15;
  const map = {
    getCenter: () => ({ toJSON: () => center }),
    getZoom: () => zoom,
    setZoomAndCenter(z, c, immediate) {
      assert.equal(immediate, true);
      zoom = z;
      center = [...c];
    },
  };
  const transit = captureViewport(map);
  center[0] = 115;
  zoom = 17;
  const communities = captureViewport(map);
  restoreViewport(map, transit);
  assert.deepEqual(captureViewport(map), { center: [114.4, 30.4], zoom: 15 });
  restoreViewport(map, communities);
  assert.deepEqual(captureViewport(map), { center: [115, 30.4], zoom: 17 });
  const routes = [{ logicalId: 'a' }, { logicalId: 'b' }];
  assert.deepEqual(visibleMapRoutes(routes, true, 'b'), [routes[1]]);
  assert.deepEqual(visibleMapRoutes(routes, false, 'b'), routes);
});
