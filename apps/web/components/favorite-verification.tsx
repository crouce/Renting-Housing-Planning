'use client';
import { useEffect, useRef, useState } from 'react';
import {
  currentFavoriteProof,
  makeFavorite,
  type Favorite,
} from '@/lib/community-collection';
import { favoriteRecheckIssue, favoriteSeed } from '@/lib/favorite-recheck';
import type {
  BoardingStation,
  CommunityVerification,
  TransitStop,
} from '@/lib/community-types';

export function FavoriteVerification({
  favorites,
  anchor,
  date,
  time,
  budget,
  seeds,
  disabled,
  onSave,
}: {
  favorites: Favorite[];
  anchor: TransitStop | null;
  date: string;
  time: string;
  budget: number;
  seeds: BoardingStation[];
  disabled: boolean;
  onSave: (item: Favorite, onlyIfSaved?: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const context = JSON.stringify([
    anchor?.id,
    anchor?.location,
    date,
    time,
    budget,
    disabled,
  ]);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy('');
    setConfirming(false);
    setSelected([]);
    setMessage('');
    return () => controller.current?.abort();
  }, [context]);
  const selectedItems = favorites.filter((item) => selected.includes(item.id));
  const eligible = (item: Favorite) =>
    !favoriteRecheckIssue(item, anchor, date, time, seeds);
  async function verify() {
    if (
      controller.current ||
      disabled ||
      !anchor ||
      !selectedItems.length ||
      selectedItems.length > 5 ||
      selectedItems.some((item) => !eligible(item))
    )
      return;
    const abort = new AbortController();
    controller.current = abort;
    setConfirming(false);
    let requested = 0,
      reused = 0,
      failed = 0;
    try {
      for (const [index, item] of selectedItems.entries()) {
        if (abort.signal.aborted) break;
        if (currentFavoriteProof(item, anchor, date, time)) {
          reused++;
          continue;
        }
        const seed = favoriteSeed(item, seeds)!;
        setBusy(
          `核验收藏 ${index + 1}/${selectedItems.length}：${item.community.name}`,
        );
        let result: CommunityVerification;
        try {
          requested++;
          const response = await fetch('/api/amap/communities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: abort.signal,
            body: JSON.stringify({
              action: 'verify',
              community: item.community,
              anchor,
              seed,
              budgetMinutes: budget,
              departureDate: date,
              departureTime: time,
            }),
          });
          const data = await response.json() as CommunityVerification & { error?: { message?: string } };
          if (!response.ok)
            throw new Error(data.error?.message ?? '收藏核验失败');
          result = data;
        } catch (error) {
          if (abort.signal.aborted) break;
          result = {
            communityId: item.community.id,
            seedId: seed.id,
            status: 'error',
            geometry: [],
            checkedAt: Date.now(),
            cached: false,
            message:
              error instanceof Error ? error.message : '核验失败，请重试。',
          };
        }
        if (abort.signal.aborted) break;
        if (result.status === 'error' || result.status === 'no_route') failed++;
        onSave(
          makeFavorite(item.community, anchor, seed, date, time, result),
          true,
        );
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy('');
        setMessage(
          `${abort.signal.aborted ? '已停止，完成的记录已保留。' : '核验完成。'}本地复用 ${reused} 个，提交核验 ${requested} 个（服务端可能复用），失败或未匹配 ${failed} 个。`,
        );
      }
    }
  }
  if (!favorites.length) return null;
  return (
    <details className="favorite-recheck">
      <summary>从收藏重新核验（最多 5 个）</summary>
      <p className="community-hint">
        当前公司：{anchor?.name ?? '尚未选择'} · {date} {time} · {budget}{' '}
        分钟。保持收藏指定的线路和上下车站，不重新搜索小区；有效记录自动复用。
      </p>
      {favorites.map((item) => {
        const issue = favoriteRecheckIssue(item, anchor, date, time, seeds);
        return (
          <label className="favorite-recheck-option" key={item.id}>
            <input
              type="checkbox"
              aria-label={`选择收藏核验${item.community.name}`}
              checked={selected.includes(item.id)}
              disabled={
                Boolean(busy) ||
                disabled ||
                Boolean(issue) ||
                (!selected.includes(item.id) && selectedItems.length >= 5)
              }
              onChange={(event) => {
                setConfirming(false);
                setSelected((ids) =>
                  event.target.checked
                    ? [
                        ...ids.filter((id) =>
                          favorites.some((f) => f.id === id),
                        ),
                        item.id,
                      ]
                    : ids.filter((id) => id !== item.id),
                );
              }}
            />
            <span>
              {item.community.name}
              <small>
                {issue ||
                  `${item.route.lineName} · ${item.route.directionLabel} · ${item.route.boarding} → ${item.route.alighting}`}
              </small>
            </span>
          </label>
        );
      })}
      {busy ? (
        <>
          <p role="status">{busy}</p>
          <button type="button" onClick={() => controller.current?.abort()}>
            停止收藏核验
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={
            disabled ||
            !selectedItems.length ||
            selectedItems.some((item) => !eligible(item))
          }
          onClick={() => setConfirming(true)}
        >
          准备核验所选（{selectedItems.length} 个）
        </button>
      )}
      {confirming && (
        <div
          role="region"
          aria-label="确认收藏核验条件"
          className="favorite-recheck-confirm"
        >
          <strong>确认本次核验</strong>
          <p>
            到 {anchor?.name} · {date} {time} 出发 · 预算 {budget} 分钟
          </p>
          <ul>
            {selectedItems.map((item) => (
              <li key={item.id}>
                {item.community.name}：{item.route.lineName}，
                {item.route.directionLabel}，{item.route.boarding} →{' '}
                {item.route.alighting}
              </li>
            ))}
          </ul>
          <p>
            仅查询上述收藏；不会自动更换工作地点或线路，旧记录会更新为本次核验结果。
          </p>
          <button
            type="button"
            disabled={disabled || !selectedItems.length}
            onClick={() => void verify()}
          >
            确认并核验
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            取消
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="community-hint">
          {message}
        </p>
      )}
    </details>
  );
}
