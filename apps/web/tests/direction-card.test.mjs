import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(
  new URL('../components/direction-status-card.tsx', import.meta.url),
  'utf8',
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replace(
    '"react/jsx-runtime"',
    JSON.stringify(import.meta.resolve('react/jsx-runtime')),
  )
  .replace(
    "'@/lib/duration'",
    JSON.stringify(new URL('../lib/duration.ts', import.meta.url).href),
  );
const { DirectionStatusCard } = await import(
  `data:text/javascript,${encodeURIComponent(compiled)}`
);
const direction = {
  id: 'direction-a',
  lineName: '2号线(甲--乙)',
  directionLabel: '开往乙',
  status: 'reachable',
  boundaryConfirmed: false,
  pendingCount: 1,
  errorCount: 0,
  noRouteCount: 0,
  cached: false,
  routeCheckCount: 2,
  evidence: [
    { stationName: '远站', status: 'unverified' },
    { stationName: '中站', status: 'reachable', durationSeconds: 1201 },
  ],
};
const route = {
  name: '中站',
  durationSeconds: 1501,
  transitDurationSeconds: 1201,
  straightLineMeters: 2100,
  routeGeometry: [{}],
};
const render = (props) =>
  renderToStaticMarkup(
    createElement(DirectionStatusCard, {
      busy: false,
      disabled: false,
      onRetry() {},
      ...props,
    }),
  );

test('one direction card retains its result and folds supporting evidence by default', () => {
  const html = render({ direction, route, active: true, onActivate() {} });
  assert.equal((html.match(/<article/g) ?? []).length, 1);
  assert.match(html, /最远已验证站/);
  assert.match(html, /25 分 1 秒/);
  assert.match(html, /最远边界待确认/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /计算详情 · 2 个站点记录/);
  assert.match(html, /尚未核验/);
  assert.match(html, /到公司步行/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test('empty and failed directions remain visible, with distinct statuses and retry behavior', () => {
  for (const [status, label] of [
    ['error', '接口失败'],
    ['no_route', '未返回匹配的直达方案'],
    ['over_budget', '已验证超时'],
    ['no_candidate', '该方向没有上游站点'],
  ]) {
    const confirmed = status === 'over_budget' || status === 'no_candidate';
    const html = render({
      direction: {
        ...direction,
        status,
        boundaryConfirmed: confirmed,
        errorCount: status === 'error' ? 1 : 0,
        noRouteCount: status === 'no_route' ? 1 : 0,
      },
    });
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /查看路线|最远已验证站/);
    assert.equal(html.includes('补查此方向'), !confirmed);
  }
});
