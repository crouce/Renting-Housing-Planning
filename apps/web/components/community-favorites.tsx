'use client';
import { useEffect, useRef, useState } from 'react';
import { FavoriteVerification } from './favorite-verification';
import type { CommunityMapSelection } from '@/lib/community-map';
import { formatDuration } from '@/lib/duration';
import {
  currentFavoriteProof,
  type Favorite,
} from '@/lib/community-collection';
import type { BoardingStation, TransitStop } from '@/lib/community-types';
import type { EntranceKind } from '@/lib/entrances';

export function CommunityFavorites({
  favorites,
  onRemove,
  anchor,
  date,
  time,
  budget,
  remember,
  notice,
  seeds = [],
  disabled = false,
  onSave,
  onMapChange,
  onEditEntrance,
}: {
  favorites: Favorite[];
  onRemove: (id: string) => void;
  anchor: TransitStop | null;
  date: string;
  time: string;
  budget: number;
  remember: boolean;
  notice: string;
  seeds?: BoardingStation[];
  disabled?: boolean;
  onSave?: (item: Favorite, onlyIfSaved?: boolean) => void;
  onMapChange?: (selection: CommunityMapSelection) => void;
  onEditEntrance?: (kind: EntranceKind, place: TransitStop) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [clock, tick] = useState(0);
  const cards = useRef(new Map<string, HTMLElement>());
  const [located, setLocated] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const chosen = favorites.filter((item) => checked.includes(item.id));
  const duration = (value: number | undefined) =>
    value === undefined || !Number.isFinite(value) || value < 0
      ? '待确认'
      : formatDuration(value);
  const state = (item: Favorite) =>
    currentFavoriteProof(item, anchor, date, time)
      ? item.verification?.totalSeconds !== undefined &&
        item.verification.totalSeconds <= budget * 60
        ? '近期核验 · 当前预算内'
        : '近期核验 · 超过当前预算'
      : item.verification
        ? '历史或条件不同 · 待重新核验'
        : '尚未核验';
  function drawFavorite(item: Favorite, focus: boolean) {
    onMapChange?.({
      communities: [item.community],
      activeId: item.community.id,
      source: 'favorites',
      focus,
      anchor: item.anchor,
      states: {
        [item.community.id]: {
          favorite: true,
          status: currentFavoriteProof(item, anchor, date, time)
            ? item.verification!.totalSeconds! <= budget * 60
              ? 'reachable'
              : 'over_budget'
            : 'pending',
        },
      },
      onSelect: () => {
        cards.current.get(item.id)?.focus({ preventScroll: true });
        cards.current
          .get(item.id)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    });
  }
  function locate(item: Favorite) {
    setLocated(item.id);
    drawFavorite(item, true);
  }
  useEffect(() => {
    const item = favorites.find((item) => item.id === located);
    if (item) drawFavorite(item, false);
    else if (located) {
      setLocated(undefined);
      onMapChange?.({ communities: [], source: 'favorites', focus: false });
    }
  }, [favorites, located, anchor, date, time, budget, clock, onMapChange]);
  return (
    <section className="community-favorites" aria-label="收藏与对比">
      <h2>
        收藏与对比 <small>{favorites.length} / 20</small>
      </h2>
      <p className="community-hint">
        {remember
          ? '收藏独立保存，不随查询缓存淘汰。'
          : '本机记忆已关闭，仅在当前页面保留。'}{' '}
        勾选 2～3 个对比；不会自动发起查询。
      </p>
      {notice && (
        <p role="status" className="community-error">
          {notice}
        </p>
      )}
      {!favorites.length && (
        <p className="direction-empty">
          在小区卡片点击“收藏小区”，下次无需重新搜索即可查看记录。
        </p>
      )}
      <div className="favorite-list">
        {favorites.map((item) => (
          <article
            key={item.id}
            tabIndex={-1}
            className={located === item.id ? 'is-located' : ''}
            ref={(node) => {
              if (node) cards.current.set(item.id, node);
              else cards.current.delete(item.id);
            }}
          >
            {onEditEntrance && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onEditEntrance('community', item.community)}
                aria-label={`校正收藏${item.community.name}的入口`}
              >
                校正入口
              </button>
            )}
            <label>
              <input
                type="checkbox"
                aria-label={`对比${item.community.name}（${item.anchor.name}）`}
                checked={checked.includes(item.id)}
                disabled={!checked.includes(item.id) && chosen.length >= 3}
                onChange={(event) =>
                  setChecked((current) =>
                    event.target.checked
                      ? [
                          ...current.filter((id) =>
                            favorites.some((f) => f.id === id),
                          ),
                          item.id,
                        ]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              <span>
                <strong>{item.community.name}</strong>
                <small>
                  到 {item.anchor.name} · {item.date} {item.time}
                </small>
                <small>{state(item)}</small>
              </span>
            </label>
            <div className="favorite-item-actions">
              {onMapChange && (
                <button
                  type="button"
                  aria-label={`定位收藏${item.community.name}`}
                  onClick={() => locate(item)}
                >
                  定位
                </button>
              )}
              <button
                type="button"
                aria-label={`移除收藏${item.community.name}（${item.anchor.name}）`}
                onClick={() => {
                  setChecked((current) =>
                    current.filter((id) => id !== item.id),
                  );
                  onRemove(item.id);
                }}
              >
                移除
              </button>
            </div>
          </article>
        ))}
      </div>
      {located && (
        <p className="community-hint">
          地图展示收藏位置与对应公司，不代表已重新核验路线。
        </p>
      )}
      {onSave && (
        <FavoriteVerification
          favorites={favorites}
          anchor={anchor}
          date={date}
          time={time}
          budget={budget}
          seeds={seeds}
          disabled={disabled}
          onSave={onSave}
        />
      )}
      {chosen.length === 1 && (
        <p className="community-hint">再选 1 个小区即可对比。</p>
      )}
      {chosen.length === 3 && (
        <p className="community-hint">左右滑动表格可查看全部 3 个小区。</p>
      )}
      {chosen.length >= 2 && (
        <div
          className={`favorite-comparison${chosen.length === 3 ? ' is-wide' : ''}`}
          role="region"
          aria-label="小区通勤对比表"
          tabIndex={0}
        >
          <table>
            <caption>
              收藏快照对比：不同公司、日期或时段不能直接当作同条件排名；历史耗时仅供参考。
            </caption>
            <thead>
              <tr>
                <th scope="col">项目</th>
                {chosen.map((item) => (
                  <th scope="col" key={item.id}>
                    {item.community.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['工作地点', (item: Favorite) => item.anchor.name],
                  ['出发条件', (item: Favorite) => `${item.date} ${item.time}`],
                  ['记录状态', state],
                  [
                    '总通勤（记录）',
                    (item: Favorite) =>
                      duration(item.verification?.totalSeconds),
                  ],
                  [
                    '小区到站步行',
                    (item: Favorite) =>
                      duration(item.verification?.homeWalkSeconds),
                  ],
                  [
                    '到公司步行',
                    (item: Favorite) =>
                      duration(item.verification?.companyWalkSeconds),
                  ],
                  [
                    '公共交通（含候车）',
                    (item: Favorite) =>
                      duration(item.verification?.transitSeconds),
                  ],
                  [
                    '线路 / 方向',
                    (item: Favorite) =>
                      `${item.route.lineName} · ${item.route.directionLabel}`,
                  ],
                  [
                    '上车 → 下车',
                    (item: Favorite) =>
                      `${item.route.boarding} → ${item.route.alighting}`,
                  ],
                  [
                    '核验时间',
                    (item: Favorite) =>
                      item.verification
                        ? new Date(item.verification.checkedAt).toLocaleString(
                            'zh-CN',
                            { timeZone: 'Asia/Shanghai', hour12: false },
                          ) + '（北京时间）'
                        : '尚未核验',
                  ],
                ] as const
              ).map(([label, cell]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {chosen.map((item) => (
                    <td key={item.id}>{cell(item)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="community-hint">
        收藏不代表路线永久有效，也不代表小区有房出租。关闭本机记忆或清空本机记录会同时清除收藏。
      </p>
    </section>
  );
}
