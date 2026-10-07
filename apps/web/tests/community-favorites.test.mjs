import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
function componentCode(name) {
  let code = ts.transpileModule(
    readFileSync(
      new URL('../components/' + name + '.tsx', import.meta.url),
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
      /from ['"]\.\/([^'"]+)['"]/g,
      (_, child) =>
        'from ' +
        JSON.stringify(
          'data:text/javascript,' + encodeURIComponent(componentCode(child)),
        ),
    )
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
  return code;
}
const { CommunityFavorites } = await import(
  'data:text/javascript,' +
    encodeURIComponent(componentCode('community-favorites'))
);
const { CommunityComparison } = await import(
  'data:text/javascript,' +
    encodeURIComponent(componentCode('community-comparison'))
);
test('time comparison exposes bounded explicit controls and does not imply reliability or alter saved time', () => {
  const c = {
    id: 'h',
    name: '测试小区',
    location: '114,30',
    address: '',
    distanceMeters: 0,
    seedIds: [],
  };
  const a = { id: 'a', name: '公司', location: '114.01,30.01' };
  const seed = {
    id: 's',
    directionId: 'd',
    station: c,
    accessStation: a,
    stops: [c, a],
    lineName: '线路',
    lineId: 'l',
    directionLabel: '方向',
    citycode: '027',
    transitSeconds: 10,
    companyWalkSeconds: 10,
  };
  const html = renderToStaticMarkup(
    createElement(CommunityComparison, {
      community: c,
      anchor: a,
      seeds: [seed],
      date: '2099-01-01',
      time: '08:30',
      budget: 30,
      mode: 'times',
    }),
  );
  assert.equal((html.match(/type="time"/g) || []).length, 3);
  assert.match(html, /不代表准点率/);
  assert.match(html, /不覆盖收藏的常用出发时间/);
  assert.match(html, /准备对比出发时段/);
  assert.doesNotMatch(html, /确认开始对比/);
});
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
