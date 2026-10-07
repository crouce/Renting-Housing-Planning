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
const { clearAllLocalMemory } = await import(
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
