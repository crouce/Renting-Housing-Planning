'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COLLECTION_KEY,
  addFavorite,
  emptyCollection,
  parseCollection,
  setIgnored,
  type CommunityCollection,
  type Favorite,
} from '@/lib/community-collection';

export function useCommunityCollection(
  enabled: boolean,
  ready: boolean,
  epoch: number,
) {
  const [collection, setCollection] = useState(emptyCollection);
  const [notice, setNotice] = useState('');
  const ref = useRef(collection);
  useEffect(() => {
    if (!ready) return;
    let next = emptyCollection();
    try {
      if (enabled)
        next = parseCollection(window.localStorage.getItem(COLLECTION_KEY));
    } catch {
      setNotice('本机存储不可用，收藏只在当前页面保留。');
    }
    ref.current = next;
    setCollection(next);
  }, [enabled, ready, epoch]);
  const update = useCallback(
    (change: (previous: CommunityCollection) => CommunityCollection) => {
      try {
        const next = change(ref.current);
        if (next === ref.current) return;
        ref.current = next;
        setCollection(next);
        setNotice(
          enabled ? '' : '本机记忆已关闭，收藏和暂不考虑仅在当前页面保留。',
        );
        if (enabled && ready) {
          try {
            window.localStorage.setItem(COLLECTION_KEY, JSON.stringify(next));
          } catch {
            setNotice('本机空间不足或不可用，本次修改仅在当前页面保留。');
          }
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '收藏更新失败。');
      }
    },
    [enabled, ready],
  );
  const save = useCallback(
    (favorite: Favorite, onlyIfSaved = false) =>
      update((previous) =>
        onlyIfSaved &&
        !previous.favorites.some((item) => item.id === favorite.id)
          ? previous
          : addFavorite(previous, favorite),
      ),
    [update],
  );
  const remove = useCallback(
    (id: string) =>
      update((previous) => ({
        ...previous,
        favorites: previous.favorites.filter((item) => item.id !== id),
      })),
    [update],
  );
  const ignore = useCallback(
    (id: string, ignored: boolean) =>
      update((previous) => setIgnored(previous, id, ignored)),
    [update],
  );
  return { ...collection, notice, save, remove, ignore };
}
