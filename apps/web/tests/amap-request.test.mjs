import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(
  readFileSync(
    new URL('../lib/amap-server.ts', import.meta.url),
    'utf8',
  ).replaceAll('import.meta.env.', 'process.env.'),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const { amapRequest } = await import(
  'data:text/javascript,' + encodeURIComponent(compiled)
);

test('actual upstream counter includes retries; abort propagates and prevents retries', async () => {
  const originalFetch = globalThis.fetch,
    originalKey = process.env.AMAP_WEB_SERVICE_KEY;
  process.env.AMAP_WEB_SERVICE_KEY = 'test-only-fake-key';
  try {
    let fetches = 0,
      counted = 0;
    globalThis.fetch = async () => {
      fetches++;
      if (fetches === 1) throw new Error('mock transient failure');
      return Response.json({ status: '1', route: {} });
    };
    await amapRequest('/test', new URLSearchParams(), {
      onRequest: () => counted++,
    });
    assert.equal(fetches, 2);
    assert.equal(counted, 2);
    const control = new AbortController();
    globalThis.fetch = async (_url, options) => {
      fetches++;
      control.abort();
      options.signal.throwIfAborted();
    };
    await assert.rejects(
      amapRequest('/test', new URLSearchParams(), {
        signal: control.signal,
        onRequest: () => counted++,
      }),
      { name: 'AbortError' },
    );
    assert.equal(fetches, 3);
    assert.equal(counted, 3);
    await assert.rejects(
      amapRequest('/test', new URLSearchParams(), {
        signal: control.signal,
        onRequest: () => counted++,
      }),
      { name: 'AbortError' },
    );
    assert.equal(counted, 3, 'already cancelled work makes no request');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
    else process.env.AMAP_WEB_SERVICE_KEY = originalKey;
  }
});
