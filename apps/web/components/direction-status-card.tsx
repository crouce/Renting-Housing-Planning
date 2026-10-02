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
  route,
  active,
  onActivate,
  busy,
  disabled,
  onRetry,
}: {
  direction: DirectionSummary;
  route?: {
    name: string;
    durationSeconds: number;
    transitDurationSeconds: number;
    straightLineMeters: number;
    routeGeometry: unknown[];
  };
  active?: boolean;
  onActivate?: () => void;
  busy: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  const unresolved = !direction.boundaryConfirmed;
  return (
    <article
      className={`direction-status-card direction-route-card${unresolved ? ' is-pending' : ''}${active ? ' is-active' : ''}`}
    >
      <h3>
        {direction.lineName.split(/[（(]/)[0]} · {direction.directionLabel}
      </h3>
      {route && (
        <div className="direction-route-summary">
          <div>
            <small>最远已验证站</small>
            <strong>{route.name}</strong>
          </div>
          <strong className="route-total">
            {formatDuration(route.durationSeconds)}
          </strong>
        </div>
      )}
      <p>
        {statusLabels[direction.status]}
        {direction.status === 'reachable' &&
          (direction.boundaryConfirmed
            ? ' · 本方向最远站已确认'
            : ' · 最远边界待确认')}
      </p>
      <div className="direction-status-actions">
        {route && (
          <button
            type="button"
            aria-pressed={Boolean(active)}
            disabled={!route.routeGeometry.length}
            onClick={onActivate}
          >
            {active ? '已在地图高亮' : '查看路线'}
          </button>
        )}
        {unresolved && (
          <button type="button" disabled={disabled} onClick={onRetry}>
            {busy ? '正在补查…' : '补查此方向'}
          </button>
        )}
      </div>
      <details className="direction-evidence">
        <summary>
          计算详情
          {direction.evidence.length > 0
            ? ` · ${direction.evidence.length} 个站点记录`
            : ''}
        </summary>
        {route && (
          <p>
            公共交通 {formatDuration(route.transitDurationSeconds)} + 到公司步行{' '}
            {formatDuration(
              route.durationSeconds - route.transitDurationSeconds,
            )}{' '}
            · 直线 {(route.straightLineMeters / 1000).toFixed(1)} 公里
          </p>
        )}
        <p>
          本次新查 {direction.routeCheckCount} 次
          {(direction.reusedCheckCount ?? 0) > 0 &&
            ` · 复用 ${direction.reusedCheckCount} 条路线证据`}
        </p>
        {unresolved && (
          <p>
            还有 {direction.pendingCount} 个站点待确认
            {direction.errorCount > 0 &&
              `，其中 ${direction.errorCount} 个接口失败`}
            {direction.noRouteCount > 0 &&
              `，${direction.noRouteCount} 个未返回匹配方案`}
            。未取得方案不代表不可达。
          </p>
        )}
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
    </article>
  );
}
