import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
let code = ts.transpileModule(
  readFileSync(
    new URL('../components/community-favorites.tsx', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
code = code
  .replace(
    /from ['"]react['"]/g,
    'from ' + JSON.stringify(import.meta.resolve('react')),
  )
  .replace(
    '"react/jsx-runtime"',
    JSON.stringify(import.meta.resolve('react/jsx-runtime')),
  )
  .replace(
    /from ['"]@\/lib\/([^'"]+)['"]/g,
    (_, name) =>
      'from ' +
      JSON.stringify(new URL('../lib/' + name + '.ts', import.meta.url).href),
  );
const { CommunityFavorites } = await import(
  'data:text/javascript,' + encodeURIComponent(code)
);
const item = {
  id: 'a',
  community: { name: '测试小区' },
  anchor: { id: 'c', name: '原公司', location: '114,30' },
  date: '2020-01-01',
  time: '08:30',
  route: {
    lineName: '2号线',
    directionLabel: '开往甲',
    boarding: 'A',
    alighting: 'B',
  },
  verification: {
    checkedAt: Date.now() - 700000,
    status: 'reachable',
    totalSeconds: 300,
  },
};
test('favorites remain accessible without live query results and mark stale context explicitly', () => {
  const html = renderToStaticMarkup(
    createElement(CommunityFavorites, {
      favorites: [item],
      onRemove() {},
      anchor: null,
      date: '2026-10-07',
      time: '09:00',
      budget: 30,
      remember: true,
      notice: '',
    }),
  );
  assert.match(html, /测试小区/);
  assert.match(html, /原公司/);
  assert.match(html, /历史或条件不同/);
  assert.match(html, /不会自动发起查询/);
  assert.match(html, /不随查询缓存淘汰/);
});
test('memory-disabled collection clearly states session-only retention', () => {
  const html = renderToStaticMarkup(
    createElement(CommunityFavorites, {
      favorites: [],
      onRemove() {},
      anchor: null,
      date: '',
      time: '',
      budget: 30,
      remember: false,
      notice: '',
    }),
  );
  assert.match(html, /仅在当前页面保留/);
});
