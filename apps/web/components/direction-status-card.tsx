import type { DirectionSummary } from '@/lib/reachability-types';
import { formatDuration } from '@/lib/duration';

const statusLabels = {
  reachable: '已验证可达',
  over_budget: '已验证超时',
  no_route: '未返回匹配的直达方案',
  error: '接口失败',
  unverified: '尚未核验',
  no_candidate: '该方向没有上游站点',
} as const;

export function DirectionStatusCard({
  direction,
  busy,
  disabled,
  onRetry,
}: {
  direction: DirectionSummary;
  busy: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  const unresolved = !direction.boundaryConfirmed;
  return (
    <div className={`direction-status-card${unresolved ? ' is-pending' : ''}`}>
      <strong>
        {direction.lineName.split(/[（(]/)[0]} · {direction.directionLabel}
      </strong>
      <p>
        {statusLabels[direction.status]}
        {direction.status === 'reachable' &&
          (direction.boundaryConfirmed
            ? ' · 本方向最远站已确认'
            : ' · 最远边界待确认')}
      </p>
      {unresolved && (
        <small>
          还有 {direction.pendingCount} 个站点待确认
          {direction.errorCount > 0 &&
            `，其中 ${direction.errorCount} 个接口失败`}
          {direction.noRouteCount > 0 &&
            `，${direction.noRouteCount} 个未返回匹配方案`}
          。未取得方案不代表不可达。
        </small>
      )}
      <div className="direction-status-actions">
        <span>
          {direction.cached
            ? '复用最近核验'
            : `本次核验 ${direction.routeCheckCount} 次`}
        </span>
        {unresolved && (
          <button type="button" disabled={disabled} onClick={onRetry}>
            {busy
              ? '正在核验…'
              : direction.errorCount || direction.noRouteCount
                ? '重试此方向'
                : '继续核验此方向'}
          </button>
        )}
      </div>
      {direction.evidence.length > 0 && (
        <details className="direction-evidence">
          <summary>
            查看 {direction.evidence.length} 个沿线站点的核验记录
          </summary>
          <ul>
            {direction.evidence.map((item, index) => (
              <li key={`${item.stationName}:${index}`}>
                <span>{item.stationName}</span>
                <span>
                  {statusLabels[item.status]}
                  {item.durationSeconds !== undefined
                    ? ` · 公共交通 ${formatDuration(item.durationSeconds)}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
