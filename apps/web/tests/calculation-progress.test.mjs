import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const source = readFileSync(
  new URL('../components/calculation-progress.tsx', import.meta.url),
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
  );
const { CalculationProgress } = await import(
  'data:text/javascript,' + encodeURIComponent(compiled)
);
const progress = {
  phase: 'routes',
  label: '2号线 · 开往乙',
  completedDirections: 1,
  totalDirections: 4,
  requests: { walking: 0, lines: 1, transit: 8 },
  reused: { walking: 2, lines: 0, transit: 5 },
};
const render = (props) =>
  renderToStaticMarkup(
    createElement(CalculationProgress, {
      progress,
      running: true,
      stopped: false,
      invalidDate: false,
      onStop() {},
      onResume() {},
      ...props,
    }),
  );
test('progress distinguishes processed directions, real calls and confirmed boundary', () => {
  const html = render({});
  assert.match(html, /停止计算/);
  assert.match(html, /1 \/ 4 个方向/);
  assert.match(html, /value="1" max="4"/);
  assert.match(html, /本次实际请求/);
  assert.match(html, /缓存复用/);
  assert.match(html, /处理完成不等于最远边界已确认/);
  assert.doesNotMatch(
    render({ progress: { ...progress, totalDirections: 0 } }),
    /<progress/,
  );
});
test('stopped work resumes explicitly and expired dates disable resume', () => {
  const stopped = render({ running: false, stopped: true, invalidDate: true });
  assert.match(stopped, /已完成结果保留/);
  assert.match(stopped, /<button[^>]+disabled=""[^>]*>继续未完成计算/);
  assert.doesNotMatch(
    render({ running: false, stopped: false }),
    /继续未完成计算|停止计算<\/button>/,
  );
});
