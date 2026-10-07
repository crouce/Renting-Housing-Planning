'use client';
import { useEffect, useRef, useState } from 'react';
import {
  comparisonTask,
  comparisonWinners,
  freshComparison,
  runComparison,
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
}) {
  const [checked, setChecked] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [ran, setRan] = useState(false),
    [message, setMessage] = useState(''),
    [results, setResults] = useState<Record<string, CommunityVerification>>({});
  const controller = useRef<AbortController | null>(null);
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
  ]);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setChecked([]);
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
  const tasks = seeds
    .filter((s) => checked.includes(s.id))
    .map((s) => comparisonTask(community, anchor, s, date, time));
  const known = { ...proofs, ...results };
  const rows = tasks.map((task) => ({
    key: task.key,
    result: known[task.key],
  }));
  const winners = comparisonWinners(rows);
  async function start() {
    if (disabled || controller.current || tasks.length < 2 || tasks.length > 3)
      return;
    const abort = new AbortController();
    controller.current = abort;
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
      aria-label={`${community.name}的多方案对比`}
    >
      <h4>同一小区多方案对比</h4>
      <p>
        手动选 2～3
        条候选方案；只核验选中项，不搜索额外线路。排名仅限所选且有效的结果。
      </p>
      {seeds.map((seed) => (
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
            {seed.station.name} → {seed.accessStation.name}
            <small>
              {seed.lineName} · {seed.directionLabel}
            </small>
          </span>
        </label>
      ))}
      {seeds.length < 2 && (
        <p>
          该小区当前仅有一个候选方案，可搜索其他已核验站点附近的小区后再比较。
        </p>
      )}
      <button
        type="button"
        disabled={busy || disabled || tasks.length < 2}
        onClick={() => setConfirm(true)}
      >
        准备对比所选方案
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
            {date} · {time} 出发 · {budget} 分钟预算
          </p>
          <p>
            {tasks.length} 项；预计最多提交{' '}
            {tasks.filter((t) => !freshComparison(known[t.key])).length}{' '}
            项核验。
          </p>
          <ul>
            {tasks.map((t) => (
              <li key={t.key}>
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
                  {task.seed.station.name} ·{' '}
                  {task.seed.lineName.split(/[（(]/)[0]}
                </strong>
                <small>
                  {task.seed.directionLabel} → {task.seed.accessStation.name}
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
                    ，10 分钟有效
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
