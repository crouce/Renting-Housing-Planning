'use client';
import { useEffect, useRef, useState } from 'react';
import {
  comparisonTask,
  comparisonWinners,
  freshComparison,
  runComparison,
  suggestedTimes,
  validComparisonTimes,
  type ComparisonTask,
} from '@/lib/commute-comparison';
import { classifyCommunity, seedIdentity } from '@/lib/cache-policy';
import { formatDuration } from '@/lib/duration';
import type {
  BoardingStation,
  Community,
  CommunityVerification,
  TransitStop,
} from '@/lib/community-types';
const EMPTY_PROOFS: Record<string, CommunityVerification> = {};
export function CommunityComparison({
  community,
  anchor,
  seeds,
  date,
  time,
  budget,
  proofs = EMPTY_PROOFS,
  disabled = false,
  onProof,
  onChoose,
  onBusy,
  mode = 'routes',
}: {
  community: Community;
  anchor: TransitStop;
  seeds: BoardingStation[];
  date: string;
  time: string;
  budget: number;
  proofs?: Record<string, CommunityVerification>;
  disabled?: boolean;
  onProof?: (task: ComparisonTask, result: CommunityVerification) => void;
  onChoose?: (seed: BoardingStation) => void;
  onBusy?: (busy: boolean) => void;
  mode?: 'routes' | 'times';
}) {
  const [checked, setChecked] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [ran, setRan] = useState(false),
    [message, setMessage] = useState(''),
    [results, setResults] = useState<Record<string, CommunityVerification>>({});
  const controller = useRef<AbortController | null>(null);
  const [times, setTimes] = useState(() => suggestedTimes(time));
  const [clock, tick] = useState(0);
  const context = JSON.stringify([
    community.id,
    community.location,
    anchor.id,
    anchor.location,
    date,
    time,
    budget,
    seeds.map(seedIdentity),
    disabled,
    mode,
  ]);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setChecked([]);
    setTimes(suggestedTimes(time));
    setConfirm(false);
    setBusy(false);
    setRan(false);
    setResults({});
    setMessage('');
    onBusy?.(false);
    return () => {
      controller.current?.abort();
      onBusy?.(false);
    };
  }, [context]);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const tasks =
    mode === 'times'
      ? seeds[0] && validComparisonTimes(times)
        ? times.map((value) =>
            comparisonTask(community, anchor, seeds[0], date, value),
          )
        : []
      : seeds
          .filter((s) => checked.includes(s.id))
          .map((s) => comparisonTask(community, anchor, s, date, time));
  const known = { ...proofs, ...results };
  const rows = tasks.map((task) => ({
    key: task.key,
    result: known[task.key],
  }));
  const winners = comparisonWinners(rows);
  const durations = rows
    .filter((row) => freshComparison(row.result))
    .map((row) => row.result!.totalSeconds!);
  async function start() {
    if (disabled || controller.current || tasks.length < 2 || tasks.length > 3)
      return;
    const abort = new AbortController();
    controller.current = abort;
    // Keep at most this run's three local snapshots, even after many time edits.
    setResults(
      Object.fromEntries(
        tasks
          .filter((task) => results[task.key])
          .map((task) => [task.key, results[task.key]]),
      ),
    );
    setBusy(true);
    onBusy?.(true);
    setConfirm(false);
    setRan(true);
    setMessage('正在核验所选方案，可停止后保留已完成项。');
    try {
      const count = await runComparison(
        tasks,
        budget,
        abort.signal,
        known,
        (task, result) => {
          setResults((previous) => ({ ...previous, [task.key]: result }));
          onProof?.(task, result);
        },
        async (task, signal) => {
          const response = await fetch('/api/amap/communities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              action: 'verify',
              community: task.community,
              anchor: task.anchor,
              seed: task.seed,
              budgetMinutes: budget,
              departureDate: task.date,
              departureTime: task.time,
            }),
          });
          const result = (await response.json()) as CommunityVerification & {
            error?: { message?: string };
          };
          if (!response.ok)
            throw new Error(result.error?.message ?? '查询失败');
          return result;
        },
      );
      if (controller.current === abort)
        setMessage(
          `${abort.signal.aborted ? '已停止' : '对比完成'}：本地复用 ${count.reused} 项，提交核验 ${count.requested} 项（服务端可能复用），失败/未匹配 ${count.failed} 项。`,
        );
    } catch (e) {
      if (controller.current === abort)
        setMessage(e instanceof Error ? e.message : '对比失败');
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
        onBusy?.(false);
      }
    }
  }
  return (
    <section
      className="commute-comparison"
      aria-label={`${community.name}的${mode === 'times' ? '出发时段' : '多方案'}对比`}
    >
      <h4>
        {mode === 'times' ? '收藏小区出发时段对比' : '同一小区多方案对比'}
      </h4>
      <p>
        {mode === 'times'
          ? '每次一个收藏、同一天 2～3 个时段，保持同一线路和上下车站。只表示规划预估差异，不代表准点率；不覆盖收藏的常用出发时间，结果仅保留在本页。'
          : '手动选 2～3 条候选方案；只核验选中项，不搜索额外线路。排名仅限所选且有效的结果。'}
      </p>
      {mode === 'times' && (
        <div className="comparison-times">
          <p>
            {seeds[0]?.lineName} · {seeds[0]?.directionLabel}
            <br />
            {seeds[0]?.station.name} →{' '}
            {seeds[0]?.stops.at(-1)?.name ?? seeds[0]?.accessStation.name}
          </p>
          {times.map((value, index) => (
            <label key={index}>
              时段 {index + 1}
              <input
                aria-label={`对比出发时段${index + 1}`}
                type="time"
                value={value}
                disabled={busy || disabled}
                onChange={(e) => {
                  setTimes((old) =>
                    old.map((t, i) => (i === index ? e.target.value : t)),
                  );
                  setConfirm(false);
                  setRan(false);
                }}
              />
              {times.length > 2 && (
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => {
                    setTimes((old) => old.filter((_, i) => i !== index));
                    setConfirm(false);
                    setRan(false);
                  }}
                >
                  移除此时段
                </button>
              )}
            </label>
          ))}
          {times.length < 3 && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => {
                setTimes((old) => [...old, '']);
                setConfirm(false);
                setRan(false);
              }}
            >
              添加时段
            </button>
          )}
          {!validComparisonTimes(times) && (
            <p role="alert">请填写 2～3 个不同的有效时间。</p>
          )}
        </div>
      )}
      {mode === 'routes' &&
        seeds.map((seed) => (
          <label className="comparison-option" key={seed.id}>
            <input
              type="checkbox"
              aria-label={`对比方案 ${seed.station.name} ${seed.lineName} ${seed.directionLabel}`}
              checked={checked.includes(seed.id)}
              disabled={
                busy ||
                disabled ||
                (!checked.includes(seed.id) && checked.length >= 3)
              }
              onChange={(e) => {
                setChecked((ids) =>
                  e.target.checked
                    ? [...ids, seed.id]
                    : ids.filter((id) => id !== seed.id),
                );
                setConfirm(false);
                setRan(false);
              }}
            />
            <span>
              {seed.station.name} →{' '}
              {seed.stops.at(-1)?.name ?? seed.accessStation.name}
              <small>
                {seed.lineName} · {seed.directionLabel}
              </small>
            </span>
          </label>
        ))}
      {mode === 'routes' && seeds.length < 2 && (
        <p>
          该小区当前仅有一个候选方案，可搜索其他已核验站点附近的小区后再比较。
        </p>
      )}
      <button
        type="button"
        disabled={busy || disabled || tasks.length < 2}
        onClick={() => setConfirm(true)}
      >
        {mode === 'times' ? '准备对比出发时段' : '准备对比所选方案'}
      </button>
      {busy && (
        <button type="button" onClick={() => controller.current?.abort()}>
          停止对比
        </button>
      )}
      {confirm && (
        <div
          className="comparison-confirm"
          role="region"
          aria-label="确认对比条件"
        >
          <strong>确认后才发起核验</strong>
          <p>
            {community.name} → {anchor.name}
            <br />
            {date} · {mode === 'times' ? times.join(' / ') : time} 出发 ·{' '}
            {budget} 分钟预算
          </p>
          <p>
            {tasks.length} 项；预计最多提交{' '}
            {tasks.filter((t) => !freshComparison(known[t.key])).length}{' '}
            项核验。
          </p>
          <ul>
            {tasks.map((t) => (
              <li key={t.key}>
                {mode === 'times' ? `${t.time} · ` : ''}
                {t.seed.station.name} · {t.seed.lineName} ·{' '}
                {t.seed.directionLabel}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void start()}>
            确认开始对比
          </button>
          <button type="button" onClick={() => setConfirm(false)}>
            取消
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {ran && (
        <div className="comparison-results" aria-live="polite">
          {mode === 'times' && durations.length >= 2 && (
            <p>
              已核验时段耗时相差{' '}
              {formatDuration(Math.max(...durations) - Math.min(...durations))}
              。这是本次规划结果，不代表真实班次间隔或准点率。
            </p>
          )}
          {tasks.map((task) => {
            const raw = known[task.key],
              fresh = freshComparison(raw),
              result = raw && classifyCommunity(raw, budget * 60);
            const validWalk =
              fresh &&
              typeof raw.homeWalkSeconds === 'number' &&
              typeof raw.companyWalkSeconds === 'number';
            return (
              <article key={task.key}>
                <strong>
                  {mode === 'times' ? `${task.time} 出发 · ` : ''}
                  {task.seed.station.name} ·{' '}
                  {task.seed.lineName.split(/[（(]/)[0]}
                </strong>
                <small>
                  {task.seed.directionLabel} →{' '}
                  {task.seed.stops.at(-1)?.name ?? task.seed.accessStation.name}
                </small>
                <p>
                  {fresh
                    ? `${formatDuration(result!.totalSeconds!)} · ${result!.status === 'reachable' ? '预算内' : '超过预算'}`
                    : raw?.status === 'error'
                      ? '接口失败'
                      : raw?.status === 'no_route'
                        ? '指定方案未匹配'
                        : raw
                          ? '已过期，待重核'
                          : '待核验'}
                </p>
                {fresh && winners.fastest.includes(task.key) && (
                  <b>所选中总时间最短 </b>
                )}
                {validWalk && winners.leastWalking.includes(task.key) && (
                  <b>所选中步行最少</b>
                )}
                <p>
                  两端步行：
                  {validWalk
                    ? formatDuration(
                        raw.homeWalkSeconds! + raw.companyWalkSeconds!,
                      )
                    : '待确认'}
                </p>
                {raw && (
                  <small>
                    核验于 {new Date(raw.checkedAt).toLocaleTimeString('zh-CN')}
                    {fresh ? '，10 分钟有效' : '，仅为核验记录，待重新核验'}
                  </small>
                )}
                {raw?.message && <p>{raw.message}</p>}
                {fresh && onChoose && (
                  <button
                    type="button"
                    disabled={busy || disabled}
                    onClick={() => onChoose(task.seed)}
                  >
                    使用此方案并定位
                  </button>
                )}
              </article>
            );
          })}
          <small>耗时为高德规划预估；缺失步行明细不参与“步行最少”排名。</small>
        </div>
      )}
    </section>
  );
}
