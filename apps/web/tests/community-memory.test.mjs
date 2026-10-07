import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { COLLECTION_KEY } from '../lib/community-collection.ts';
const code = ts
  .transpileModule(
    readFileSync(new URL('../lib/local-memory.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  )
  .outputText.replace(
    "'./community-collection'",
    JSON.stringify(
      new URL('../lib/community-collection.ts', import.meta.url).href,
    ),
  );
const { clearAllLocalMemory, clearQueryCaches } = await import(
  'data:text/javascript,' + encodeURIComponent(code)
);
test('explicit clear removes independent favorites and ignored records together with query memory', async () => {
  const savedWindow = globalThis.window;
  const memory = new Map([
    [COLLECTION_KEY, '{}'],
    ['commute-radius:planner-memory:v1', '{}'],
    ['commute-radius:memory-enabled', 'true'],
  ]);
  let deletedDatabase;
  globalThis.window = {
    localStorage: { removeItem: (key) => memory.delete(key) },
    indexedDB: {
      deleteDatabase(name) {
        deletedDatabase = name;
        const request = {};
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
  };
  try {
    await clearAllLocalMemory();
    assert.equal(memory.has(COLLECTION_KEY), false);
    assert.equal(memory.has('commute-radius:planner-memory:v1'), false);
    assert.equal(memory.get('commute-radius:memory-enabled'), 'true');
    assert.equal(deletedDatabase, 'commute-radius-local-memory');
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
});

test('query-only clear waits for transaction completion and preserves every localStorage record', async () => {
  const previous = globalThis.window;
  const cleared = [];
  let closed = false;
  const memory = new Map([
    [COLLECTION_KEY, 'favorites'],
    ['commute-radius:planner-memory:v1', 'preferences'],
  ]);
  let finish;
  const db = {
    close() {
      closed = true;
    },
    transaction(names, mode) {
      assert.deepEqual(names, [
        'station-cache',
        'commute-cache',
        'community-cache',
      ]);
      assert.equal(mode, 'readwrite');
      const tx = {
        objectStore(name) {
          return {
            clear() {
              cleared.push(name);
            },
          };
        },
      };
      finish = () => tx.oncomplete();
      return tx;
    },
  };
  globalThis.window = {
    localStorage: { removeItem: (key) => memory.delete(key) },
    indexedDB: {
      open() {
        const request = { result: db };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
  };
  try {
    let resolved = false;
    const pending = clearQueryCaches().then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    assert.equal(closed, false);
    finish();
    await pending;
    assert.equal(closed, true);
    assert.equal(cleared.length, 3);
    assert.equal(memory.get(COLLECTION_KEY), 'favorites');
    assert.equal(memory.get('commute-radius:planner-memory:v1'), 'preferences');
  } finally {
    globalThis.window = previous;
  }
});
