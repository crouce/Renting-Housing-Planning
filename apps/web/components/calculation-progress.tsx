import type { CalculationProgress as Progress } from '@/lib/calculation-stream';

export function CalculationProgress({
  progress,
  running,
  stopped,
  invalidDate,
  onStop,
  onResume,
}: {
  progress: Progress | null;
  running: boolean;
  stopped: boolean;
  invalidDate: boolean;
  onStop: () => void;
  onResume: () => void;
}) {
  if (!progress && !stopped) return null;
  const count = progress?.completedDirections ?? 0;
  const total = progress?.totalDirections ?? 0;
  return (
    <section className="calculation-progress-panel" aria-label="通勤计算进度">
      <output aria-live="polite">
        <strong>
          {running
            ? '正在计算'
            : stopped
              ? '已停止 · 已完成结果保留'
              : '本轮计算完成'}
        </strong>
        <span>{progress?.label ?? '准备继续查询'}</span>
        <span>
          {total
            ? `本轮已处理 ${count} / ${total} 个方向`
            : '正在准备接驳步行与线路站序'}
        </span>
      </output>
      {total > 0 && (
        <progress aria-label="已处理线路方向" value={count} max={total} />
      )}
      {progress && (
        <p>
          本次实际请求：步行 {progress.requests.walking} · 线路{' '}
          {progress.requests.lines} · 路线 {progress.requests.transit}
          <br />
          缓存复用：步行 {progress.reused.walking} · 线路{' '}
          {progress.reused.lines} · 路线证据 {progress.reused.transit}
        </p>
      )}
      {running ? (
        <button type="button" onClick={onStop}>
          停止计算
        </button>
      ) : stopped ? (
        <button type="button" disabled={invalidDate} onClick={onResume}>
          继续未完成计算
        </button>
      ) : null}
      <small>
        处理完成不等于最远边界已确认；未确认方向仍可补查。停止不会撤销已发出的请求。
      </small>
    </section>
  );
}
