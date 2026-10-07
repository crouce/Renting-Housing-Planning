'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import type { CommunityMapSelection } from '@/lib/community-map';
export type { CommunityMapSelection } from '@/lib/community-map';
import { formatDuration } from '@/lib/duration';
import { mergeCommunities } from '@/lib/community-core';
import {
  walkingStatus,
  selectedVerificationBatch,
  toggleCommunitySelection,
  COMMUNITY_BATCH_LIMIT,
  type WalkingLimits,
} from '@/lib/community-selection';
import {
  communityChoiceKey,
  currentFavoriteProof,
  makeFavorite,
  type Favorite,
} from '@/lib/community-collection';
import { favoriteSeed } from '@/lib/favorite-recheck';
import {
  applyEntrance,
  NO_ENTRANCES,
  type Entrance,
  type EntranceKind,
} from '@/lib/entrances';
import {
  readCommunityCache,
  readCommunityHistory,
  writeCommunityCache,
} from '@/lib/local-memory';
import {
  classifyCommunity,
  communityRouteKey,
  isRecent,
  replaceStationCommunities,
  seedIdentity,
  ROUTE_FRESH_MS,
} from '@/lib/cache-policy';
import type {
  BoardingStation,
  Community,
  CommunitySearch,
  CommunityVerification,
  TransitStop,
} from '@/lib/community-types';

type PageState = Record<
  string,
  {
    page: number;
    hasMore: boolean;
    failed?: boolean;
    retryPage?: number;
    refreshPending?: boolean;
    checkedAt?: number;
  }
>;
type SavedCommunities = {
  communities: Community[];
  pages: PageState;
  verifications: Record<string, CommunityVerification>;
  choices: Record<string, string>;
};

export function CommunityExplorer({
  seeds,
  anchor,
  budgetMinutes,
  departureDate,
  departureTime,
  remember,
  memoryEpoch,
  disabled,
  onMapChange,
  favorites,
  ignored,
  onFavorite,
  onRemoveFavorite,
  onIgnore,
  entrances = NO_ENTRANCES,
  onEditEntrance,
}: {
  seeds: BoardingStation[];
  anchor: TransitStop;
  budgetMinutes: number;
  departureDate: string;
  departureTime: string;
  remember: boolean;
  memoryEpoch: number;
  disabled: boolean;
  onMapChange: (selection: CommunityMapSelection) => void;
  favorites: Favorite[];
  ignored: string[];
  onFavorite: (item: Favorite, onlyIfSaved?: boolean) => void;
  onRemoveFavorite: (id: string) => void;
  onIgnore: (id: string, ignored: boolean) => void;
  entrances?: Entrance[];
  onEditEntrance?: (kind: EntranceKind, place: TransitStop) => void;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<
      string,
      { id: string; station: TransitStop; seeds: BoardingStation[] }
    >();
    for (const seed of seeds) {
      const id = `${seed.station.name}:${seed.station.location}`;
      const group = grouped.get(id) ?? { id, station: seed.station, seeds: [] };
      group.seeds.push(seed);
      grouped.set(id, group);
    }
    return [...grouped.values()].sort(
      (a, b) =>
        Math.min(
          ...a.seeds.map(
            (seed) => seed.transitSeconds + seed.companyWalkSeconds,
          ),
        ) -
        Math.min(
          ...b.seeds.map(
            (seed) => seed.transitSeconds + seed.companyWalkSeconds,
          ),
        ),
    );
  }, [seeds]);
  const [selectedGroups, setSelectedGroups] = useState(() =>
    groups.slice(0, 3).map((group) => group.id),
  );
  const [radius, setRadius] = useState(500);
  const [rawCommunities, setCommunities] = useState<Community[]>([]);
  const communities = useMemo(
    () =>
      rawCommunities.map((item) => applyEntrance(item, 'community', entrances)),
    [rawCommunities, entrances],
  );
  const [pages, setPages] = useState<PageState>({});
  const [verifications, setVerifications] = useState<
    Record<string, CommunityVerification>
  >({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [onlyWithinBudget, setOnlyWithinBudget] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const focusMapRef = useRef(false);
  const [selectionTick, setSelectionTick] = useState(0);
  const selectCommunity = useCallback((id: string) => {
    focusMapRef.current = true;
    setActiveId(id);
    setSelectionTick((tick) => tick + 1);
    const card = cardRefs.current.get(id);
    const details = card?.querySelector('details');
    if (details) details.open = true;
    card?.querySelector('summary')?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const clearCommunity = useCallback(() => {
    focusMapRef.current = true;
    setActiveId(undefined);
    setSelectionTick((tick) => tick + 1);
  }, []);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [showIgnored, setShowIgnored] = useState(false);
  const [walkingLimits, setWalkingLimits] = useState<WalkingLimits>({
    homeMinutes: 0,
    totalMinutes: 0,
  });
  const [walkingFilter, setWalkingFilter] = useState('all');
  const [expiryTick, setExpiryTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy('');
    setActiveId(undefined);
  }, [entrances]);
  const selected = groups.filter((group) => selectedGroups.includes(group.id));
  const cacheKey = JSON.stringify([
    'communities:v2',
    anchor,
    departureDate,
    departureTime,
    radius,
    selected
      .flatMap((group) => group.seeds.map(seedIdentity))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
  const seedsById = useMemo(
    () => new Map(seeds.map((seed) => [seed.id, seed])),
    [seeds],
  );
  useEffect(() => {
    setVerifications((previous) => {
      let next = previous;
      for (const saved of favorites) {
        if (!currentFavoriteProof(saved, anchor, departureDate, departureTime))
          continue;
        const community = communities.find(
          (item) =>
            item.id === saved.community.id &&
            item.location === saved.community.location,
        );
        const seed = favoriteSeed(saved, seeds);
        if (!community || !seed || !community.seedIds.includes(seed.id))
          continue;
        const key = communityRouteKey(
          community,
          anchor,
          seed,
          departureDate,
          departureTime,
        );
        if (
          previous[key] &&
          previous[key].checkedAt >= saved.verification!.checkedAt
        )
          continue;
        if (next === previous) next = { ...previous };
        // Favorites deliberately omit geometry. Reuse timing evidence without inventing a path.
        next[key] = { ...saved.verification!, geometry: [] };
      }
      return next;
    });
  }, [favorites, communities, seeds, anchor, departureDate, departureTime]);

  useEffect(() => {
    const now = Date.now();
    const nextExpiry = Math.min(
      ...Object.values(verifications)
        .map((result) => result.checkedAt + ROUTE_FRESH_MS)
        .filter((expiry) => expiry > now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => {
        setExpiryTick((value) => value + 1);
        setActiveId(undefined);
      },
      nextExpiry - now + 10,
    );
    return () => window.clearTimeout(timer);
  }, [verifications, expiryTick]);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    let current = true;
    setCommunities([]);
    setPages({});
    setVerifications({});
    setChoices({});
    setCheckedIds([]);
    setErrors([]);
    setBusy('');
    setSearched(false);
    setMessage('');
    setActiveId(undefined);

    if (remember)
      void Promise.all([
        readCommunityCache<SavedCommunities>(cacheKey),
        readCommunityHistory<SavedCommunities>(),
      ]).then(([record, history]) => {
        if (!current || controllerRef.current) return;
        // Reuse matching routes even when the chosen station batch or radius changes.
        // Full route keys prevent reuse after coordinates, lines or time change.
        const proofs: Record<string, CommunityVerification> = {};
        for (const saved of history)
          for (const [key, result] of Object.entries(
            saved.data.verifications,
          )) {
            if (!proofs[key] || proofs[key].checkedAt < result.checkedAt)
              proofs[key] = result;
          }
        setVerifications(proofs);
        if (!record) return;
        const fresh = Object.values(record.data.pages).every(
          (page) =>
            page.checkedAt && Date.now() - page.checkedAt < 24 * 60 * 60_000,
        );
        setCommunities(record.data.communities);
        setPages(record.data.pages);
        setChoices(record.data.choices);
        setSearched(true);
        setMessage(
          fresh
            ? '近期结果：已恢复小区名单；路线证据独立保鲜 10 分钟，调整预算会重新判断。'
            : '历史结果：小区名单需要更新；仍有效的路线核验会保留。',
        );
      });
    return () => {
      current = false;
      controllerRef.current?.abort();
    };
  }, [cacheKey, remember, memoryEpoch, onMapChange]);

  function save(data: SavedCommunities) {
    if (remember) {
      const used = new Set(
        data.communities.flatMap((community) =>
          community.seedIds.flatMap((id) => {
            const seed = seedsById.get(id);
            return seed
              ? [
                  communityRouteKey(
                    applyEntrance(community, 'community', entrances),
                    anchor,
                    seed,
                    departureDate,
                    departureTime,
                  ),
                ]
              : [];
          }),
        ),
      );
      void writeCommunityCache(cacheKey, {
        ...data,
        verifications: Object.fromEntries(
          Object.entries(data.verifications).filter(([key]) => used.has(key)),
        ),
      });
    }
  }
  function chosenSeed(community: Community) {
    return seedsById.get(choices[community.id] ?? community.seedIds[0]);
  }
  function resultFor(community: Community) {
    const seed = chosenSeed(community);
    const result = seed
      ? verifications[
          communityRouteKey(
            community,
            anchor,
            seed,
            departureDate,
            departureTime,
          )
        ]
      : undefined;
    return result && isRecent(result.checkedAt)
      ? classifyCommunity(result, budgetMinutes * 60)
      : undefined;
  }
  async function api<T>(body: object, controller: AbortController): Promise<T> {
    const response = await fetch('/api/amap/communities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as T & {
      error?: { message?: string };
    };
    if (!response.ok)
      throw new Error(data.error?.message ?? '查询暂时失败，请重试。');
    return data as T;
  }
  async function search(more = false, refresh = false, failedOnly = false) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrors([]);
    setMessage('');
    let found = rawCommunities;
    const newPages = { ...pages };
    const newVerifications = verifications;
    const failures: string[] = [];
    for (const [index, group] of selected.entries()) {
      const previous = newPages[group.id];
      if (failedOnly && !previous?.failed) continue;
      if (
        more &&
        !failedOnly &&
        previous &&
        (!previous.hasMore || previous.page >= 3)
      )
        continue;
      const queryPage = failedOnly
        ? (previous?.retryPage ?? 1)
        : more
          ? (previous?.page ?? 0) + 1
          : 1;
      const forceList =
        refresh || Boolean(failedOnly && previous?.refreshPending);
      setBusy(
        `搜索站点 ${index + 1}/${selected.length}：${group.station.name}`,
      );
      try {
        const data = await api<CommunitySearch>(
          {
            action: 'search',
            station: group.station,
            seedIds: group.seeds.map((seed) => seed.id),
            radius,
            page: queryPage,
            refresh: forceList,
          },
          controller,
        );
        if (controller.signal.aborted) return;
        found =
          queryPage > 1
            ? mergeCommunities(found, data.communities)
            : replaceStationCommunities(
                found,
                data.communities,
                group.seeds.map((seed) => seed.id),
              );
        newPages[group.id] = {
          page: data.page,
          hasMore: data.hasMore,
          checkedAt:
            queryPage > 1
              ? Math.min(previous?.checkedAt ?? 0, data.checkedAt ?? 0)
              : (data.checkedAt ?? 0),
        };
        setCommunities(found);
        setPages({ ...newPages });
        setSearched(true);

        save({
          communities: found,
          pages: { ...newPages },
          verifications: newVerifications,
          choices,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        failures.push(
          `${group.station.name}：${error instanceof Error ? error.message : '搜索失败'}`,
        );
        newPages[group.id] = {
          ...(previous ?? { page: 0, hasMore: true }),
          failed: true,
          retryPage: queryPage,
          refreshPending: forceList,
        };
      }
    }
    if (controller.signal.aborted) return;
    setCommunities(found);
    setPages(newPages);
    setVerifications(newVerifications);
    setErrors(failures);
    setBusy('');
    setSearched(true);
    setActiveId(undefined);
    if (refresh)
      setMessage(
        '小区名单已更新；同位置、同线路且仍在 10 分钟内的核验已保留。失败站点继续使用原名单。',
      );
    save({
      communities: found,
      pages: newPages,
      verifications: newVerifications,
      choices,
    });
  }
  async function verify(items: Community[], refresh = false) {
    if (disabled || busy) return;
    // Single and batch paths share the same exclusion, limit, and freshness guard.
    items = items
      .filter((item) => !ignored.includes(communityChoiceKey(anchor, item)))
      .slice(0, COMMUNITY_BATCH_LIMIT);
    if (!refresh)
      items = items.filter(
        (item) =>
          !['reachable', 'over_budget'].includes(resultFor(item)?.status ?? ''),
      );
    if (!items.length) {
      setMessage('所选小区已有有效核验，无需重复请求。');
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const updated = { ...verifications };
    setErrors([]);
    for (const [index, community] of items.entries()) {
      const seed = chosenSeed(community);
      if (!seed) continue;
      setBusy(`核验 ${index + 1}/${items.length}：${community.name}`);
      let result: CommunityVerification;
      try {
        result = await api<CommunityVerification>(
          {
            action: 'verify',
            community,
            seed,
            anchor,
            budgetMinutes,
            departureDate,
            departureTime,
            refresh,
          },
          controller,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        result = {
          communityId: community.id,
          seedId: seed.id,
          status: 'error',
          geometry: [],
          checkedAt: Date.now(),
          cached: false,
          message:
            error instanceof Error ? error.message : '核验失败，请重试。',
        };
      }
      if (controller.signal.aborted) return;
      updated[
        communityRouteKey(community, anchor, seed, departureDate, departureTime)
      ] = result;
      setVerifications({ ...updated });
      onFavorite(
        makeFavorite(
          community,
          anchor,
          seed,
          departureDate,
          departureTime,
          result,
        ),
        true,
      );
      if (['reachable', 'over_budget'].includes(result.status))
        setCheckedIds((ids) => ids.filter((id) => id !== community.id));
      save({ communities, pages, verifications: updated, choices });
      if (items.length === 1) {
        focusMapRef.current = true;
        setActiveId(community.id);
      }
    }
    if (!controller.signal.aborted) {
      setBusy('');
      setMessage(
        '核验使用小区出发时间，包含两端步行及公共交通；耗时为高德预估。',
      );
    }
  }
  const sorted = useMemo(
    () =>
      [...communities].sort(
        (a, b) =>
          (resultFor(a)?.status === 'reachable' ? 0 : 1) -
            (resultFor(b)?.status === 'reachable' ? 0 : 1) ||
          (resultFor(a)?.totalSeconds ?? Infinity) -
            (resultFor(b)?.totalSeconds ?? Infinity) ||
          a.distanceMeters - b.distanceMeters,
      ),
    [
      communities,
      verifications,
      choices,
      seedsById,
      budgetMinutes,
      departureDate,
      departureTime,
      anchor,
      expiryTick,
    ],
  );
  const visible = useMemo(
    () =>
      sorted.filter((item) => {
        if (!showIgnored && ignored.includes(communityChoiceKey(anchor, item)))
          return false;
        if (onlyWithinBudget && resultFor(item)?.status !== 'reachable')
          return false;
        const walk = walkingStatus(resultFor(item), walkingLimits);
        return (
          walkingFilter === 'all' ||
          walk === 'unlimited' ||
          (walkingFilter === 'match' ? walk === 'match' : walk === 'pending')
        );
      }),
    [
      sorted,
      onlyWithinBudget,
      walkingLimits,
      walkingFilter,
      ignored,
      showIgnored,
      anchor,
    ],
  );
  const within = communities.filter(
    (item) => resultFor(item)?.status === 'reachable',
  ).length;
  const walkPending = sorted.filter(
    (item) =>
      !ignored.includes(communityChoiceKey(anchor, item)) &&
      walkingStatus(resultFor(item), walkingLimits) === 'pending',
  ).length;
  const ignoredCount = communities.filter((item) =>
    ignored.includes(communityChoiceKey(anchor, item)),
  ).length;
  const batch = selectedVerificationBatch(
    visible.filter(
      (item) => !ignored.includes(communityChoiceKey(anchor, item)),
    ),
    checkedIds,
    (item) =>
      !['reachable', 'over_budget'].includes(resultFor(item)?.status ?? ''),
  );
  const selectedVisibleCount = visible.filter(
    (item) =>
      checkedIds.includes(item.id) &&
      !ignored.includes(communityChoiceKey(anchor, item)),
  ).length;
  useEffect(() => {
    setCheckedIds((current) => {
      const retained = current.filter((id) =>
        visible.some(
          (item) =>
            item.id === id &&
            !ignored.includes(communityChoiceKey(anchor, item)),
        ),
      );
      return retained.length === current.length ? current : retained;
    });
  }, [visible, ignored, anchor]);
  // A hidden/expired result must disappear from the map as well as the list.
  useEffect(() => {
    const active = visible.find((item) => item.id === activeId);
    onMapChange({
      communities: visible,
      activeId: active?.id,
      verification: active ? resultFor(active) : undefined,
      source: 'explorer',
      focus: focusMapRef.current,
      onSelect: selectCommunity,
      onClear: clearCommunity,
      states: Object.fromEntries(
        visible.map((item) => {
          const status = resultFor(item)?.status;
          return [
            item.id,
            {
              status:
                status === 'reachable' || status === 'over_budget'
                  ? status
                  : 'pending',
              favorite: favorites.some(
                (saved) => saved.id === communityChoiceKey(anchor, item),
              ),
            },
          ];
        }),
      ),
    });
    focusMapRef.current = false;
  }, [
    visible,
    activeId,
    onMapChange,
    favorites,
    selectionTick,
    selectCommunity,
    clearCommunity,
  ]);

  const moreAvailable = selected.some(
    (group) => pages[group.id]?.hasMore && pages[group.id].page < 3,
  );

  return (
    <section
      id="commute-communities"
      className="community-section"
      aria-labelledby="community-heading"
    >
      <div className="section-heading">
        <div>
          <h2 id="community-heading" className="workflow-heading">
            <span>03</span>找小区
          </h2>
        </div>
      </div>
      <p className="community-hint">
        已核验可达的沿线站点均可选择，不只搜索最远站。每批最多选 3
        个站点；搜索范围是直线半径，实际步行另行核验。
      </p>
      {!groups.length ? (
        <p className="direction-empty">
          暂无已核验可达站点。请先计算通勤圈，或继续核验待确认方向。
        </p>
      ) : (
        <>
          <details className="community-station-picker">
            <summary>
              选择沿线站点（已选 {selected.length} / {groups.length}）
            </summary>
            <div>
              {groups.map((group) => (
                <label key={group.id}>
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(group.id)}
                    disabled={
                      Boolean(busy) ||
                      disabled ||
                      (!selectedGroups.includes(group.id) &&
                        selectedGroups.length >= 3)
                    }
                    onChange={(event) =>
                      setSelectedGroups((current) =>
                        event.target.checked
                          ? [...current, group.id]
                          : current.filter((id) => id !== group.id),
                      )
                    }
                  />
                  <span>
                    <strong>{group.station.name}</strong>
                    <small>
                      {[
                        ...new Set(
                          group.seeds.map(
                            (seed) => seed.lineName.split(/[（(]/)[0],
                          ),
                        ),
                      ].join(' / ')}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </details>
          <div className="community-controls">
            <label>
              小区搜索范围
              <select
                value={radius}
                disabled={Boolean(busy) || disabled}
                onChange={(event) => setRadius(Number(event.target.value))}
              >
                <option value={500}>500 米</option>
                <option value={1000}>1 公里</option>
              </select>
            </label>
            <button
              type="button"
              disabled={Boolean(busy) || disabled || !selected.length}
              onClick={() => void search()}
            >
              搜索小区
            </button>
            {searched && (
              <details className="update-menu">
                <summary>更多更新</summary>
                <button
                  type="button"
                  disabled={Boolean(busy) || disabled}
                  onClick={() => void search(false, true)}
                >
                  更新小区名单（保留有效核验）
                </button>
                <small>只更新名单；已核验路线按各自时间失效。</small>
              </details>
            )}
          </div>
          {busy && (
            <div className="community-progress" role="status">
              <span>{busy}</span>
              <button
                type="button"
                onClick={() => {
                  controllerRef.current?.abort();
                  setBusy('');
                  setMessage('已停止，已完成的结果仍保留。');
                }}
              >
                停止
              </button>
            </div>
          )}
          {message && (
            <p className="community-hint" role="status">
              {message}
            </p>
          )}
          {errors.length > 0 && (
            <div className="community-error" role="alert">
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
              <button
                type="button"
                disabled={Boolean(busy) || disabled}
                onClick={() => void search(true, false, true)}
              >
                补查未完成的搜索
              </button>
            </div>
          )}
          {searched && (
            <>
              <div className="community-summary">
                <strong>
                  {communities.length} 个小区 · {within} 个已核验符合预算
                </strong>
                <label>
                  <input
                    type="checkbox"
                    checked={onlyWithinBudget}
                    onChange={(event) => {
                      setOnlyWithinBudget(event.target.checked);
                      setActiveId(undefined);
                      setCheckedIds([]);
                    }}
                  />
                  仅看预算内
                </label>
              </div>
              <details
                className="community-walking-preferences"
                open={Boolean(
                  walkingLimits.homeMinutes || walkingLimits.totalMinutes,
                )}
              >
                <summary>步行偏好（仅筛选已有核验，不发请求）</summary>
                <div className="community-controls">
                  <label>
                    小区到站最多
                    <select
                      aria-label="小区到站最多步行"
                      value={walkingLimits.homeMinutes}
                      onChange={(event) => {
                        setWalkingLimits((current) => ({
                          ...current,
                          homeMinutes: Number(event.target.value),
                        }));
                        setActiveId(undefined);
                        setCheckedIds([]);
                      }}
                    >
                      {[0, 5, 10, 15, 20].map((value) => (
                        <option key={value} value={value}>
                          {value ? value + ' 分钟' : '不限'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    两端合计最多
                    <select
                      aria-label="两端合计最多步行"
                      value={walkingLimits.totalMinutes}
                      onChange={(event) => {
                        setWalkingLimits((current) => ({
                          ...current,
                          totalMinutes: Number(event.target.value),
                        }));
                        setActiveId(undefined);
                        setCheckedIds([]);
                      }}
                    >
                      {[0, 10, 15, 20, 30].map((value) => (
                        <option key={value} value={value}>
                          {value ? value + ' 分钟' : '不限'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    步行筛选
                    <select
                      aria-label="步行筛选"
                      disabled={
                        !walkingLimits.homeMinutes &&
                        !walkingLimits.totalMinutes
                      }
                      value={walkingFilter}
                      onChange={(event) => {
                        setWalkingFilter(event.target.value);
                        setActiveId(undefined);
                        setCheckedIds([]);
                      }}
                    >
                      <option value="all">全部状态</option>
                      <option value="match">仅符合偏好</option>
                      <option value="pending">仅待确认</option>
                    </select>
                  </label>
                </div>
                <p className="community-hint">
                  两端指小区到上车站、下车站到公司。步行明细缺失、未核验或过期：
                  {walkPending} 个待确认；不会按零分钟计入。
                </p>
              </details>
              <div className="community-selection-toolbar">
                <strong>已勾选 {selectedVisibleCount} / 5 个</strong>
                <button
                  className="community-batch"
                  type="button"
                  disabled={Boolean(busy) || disabled || batch.length === 0}
                  onClick={() => void verify(batch)}
                >
                  核验所选（{batch.length} 个待补查）
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy) || !checkedIds.length}
                  onClick={() => setCheckedIds([])}
                >
                  清空勾选
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={showIgnored}
                    onChange={(event) => {
                      setShowIgnored(event.target.checked);
                      setActiveId(undefined);
                      setCheckedIds([]);
                    }}
                  />
                  显示暂不考虑（{ignoredCount}）
                </label>
                <small>
                  每批最多 5
                  个，只核验当前显示且已勾选的小区。有效结果自动复用，不重复请求。
                </small>
              </div>
              {visible.length === 0 && (
                <p className="direction-empty">
                  {onlyWithinBudget
                    ? '暂未核验出预算内的小区；可取消筛选后继续核验。'
                    : communities.length
                      ? '没有符合当前筛选的小区；可切换步行状态、取消筛选或显示暂不考虑。'
                      : errors.length
                        ? '本批未取得小区结果，请重试失败站点。'
                        : '当前范围未找到住宅小区，可扩大到 1 公里或更换沿线站点。'}
                </p>
              )}
              <div className="community-list">
                {visible.map((community) => {
                  const result = resultFor(community);
                  const seed = chosenSeed(community);
                  const choiceKey = communityChoiceKey(anchor, community);
                  const excluded = ignored.includes(choiceKey);
                  const favorite = favorites.some(
                    (item) => item.id === choiceKey,
                  );
                  const walk = walkingStatus(result, walkingLimits);
                  const historical =
                    seed &&
                    verifications[
                      communityRouteKey(
                        community,
                        anchor,
                        seed,
                        departureDate,
                        departureTime,
                      )
                    ];
                  return (
                    <article
                      className={`community-card${activeId === community.id ? ' is-active' : ''}`}
                      key={community.id}
                      ref={(node) => {
                        if (node) cardRefs.current.set(community.id, node);
                        else cardRefs.current.delete(community.id);
                      }}
                    >
                      <div className="community-card-selection">
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`勾选核验${community.name}`}
                            checked={checkedIds.includes(community.id)}
                            disabled={
                              Boolean(busy) ||
                              disabled ||
                              excluded ||
                              (!checkedIds.includes(community.id) &&
                                checkedIds.length >= COMMUNITY_BATCH_LIMIT)
                            }
                            onChange={(event) =>
                              setCheckedIds((ids) =>
                                toggleCommunitySelection(
                                  ids,
                                  community.id,
                                  event.target.checked,
                                ),
                              )
                            }
                          />
                          核验
                        </label>
                        <button
                          type="button"
                          aria-label={`${favorite ? '更新收藏' : '收藏小区'}${community.name}`}
                          disabled={!seed}
                          onClick={() => {
                            if (seed)
                              onFavorite(
                                makeFavorite(
                                  community,
                                  anchor,
                                  seed,
                                  departureDate,
                                  departureTime,
                                  historical,
                                ),
                              );
                          }}
                        >
                          {favorite ? '更新收藏' : '收藏小区'}
                        </button>
                        {favorite && (
                          <button
                            type="button"
                            aria-label={`取消收藏${community.name}`}
                            onClick={() => onRemoveFavorite(choiceKey)}
                          >
                            已收藏 ×
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            onIgnore(choiceKey, !excluded);
                            setCheckedIds((ids) =>
                              ids.filter((id) => id !== community.id),
                            );
                            setActiveId(undefined);
                          }}
                        >
                          {excluded ? '恢复考虑' : '暂不考虑'}
                        </button>
                      </div>
                      {walk !== 'unlimited' && (
                        <p className={`community-walking-status is-${walk}`}>
                          {walk === 'match'
                            ? '符合步行偏好'
                            : walk === 'over'
                              ? '超出步行偏好'
                              : '步行待确认（明细缺失、尚未核验或已过期）'}
                        </p>
                      )}
                      {excluded && (
                        <p className="community-hint">
                          暂不考虑 ·
                          不参与批量核验，可随时恢复；收藏不会被删除。
                        </p>
                      )}
                      <details className="community-card-details">
                        <summary aria-label={`${community.name}的详情`}>
                          <div className="community-card-heading">
                            <h3>{community.name}</h3>
                            <span
                              className={`community-status is-${result?.status ?? 'pending'}`}
                            >
                              {!result
                                ? '待核验'
                                : result.status === 'reachable'
                                  ? '预算内'
                                  : result.status === 'over_budget'
                                    ? '超过预算'
                                    : result.status === 'error'
                                      ? '接口失败'
                                      : '方案未匹配'}
                            </span>
                          </div>
                          <div className="community-card-overview">
                            <strong>
                              {result?.totalSeconds !== undefined
                                ? `门到门约 ${formatDuration(result.totalSeconds)}`
                                : '通勤时间待核验'}
                            </strong>
                            <span>
                              上车站：{seed?.station.name ?? '待选择'}
                            </span>
                          </div>
                          <span className="community-disclosure">
                            <span className="show-detail-label">查看详情</span>
                            <span className="hide-detail-label">收起详情</span>
                          </span>
                        </summary>
                        <div className="community-card-detail-body">
                          <p className="community-hint">
                            {result
                              ? `近期结果 · ${new Date(result.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 核验`
                              : historical
                                ? '历史结果 · 需要更新，暂不计入预算内'
                                : '需要更新 · 尚未核验'}
                          </p>
                          <p>{community.address || '高德暂无详细地址'}</p>
                          <p className="community-hint">
                            {community.originalLocation
                              ? '已使用校正入口，位置改变后须重新核验。'
                              : '当前使用高德 POI 位置，可校正为实际大门。'}
                          </p>
                          {onEditEntrance && (
                            <button
                              type="button"
                              disabled={Boolean(busy) || disabled}
                              onClick={() =>
                                onEditEntrance('community', community)
                              }
                            >
                              校正小区入口
                            </button>
                          )}
                          <small>
                            距所选站点最近直线{' '}
                            {Math.round(community.distanceMeters)} 米
                          </small>
                          {community.seedIds.filter((id) => seedsById.has(id))
                            .length > 1 ? (
                            <label className="community-route-choice">
                              上车站及线路
                              <select
                                aria-label={`${community.name}的通勤线路`}
                                value={seed?.id ?? ''}
                                disabled={Boolean(busy) || disabled}
                                onChange={(event) => {
                                  const updated = {
                                    ...choices,
                                    [community.id]: event.target.value,
                                  };
                                  setChoices(updated);
                                  setActiveId(undefined);
                                  save({
                                    communities,
                                    pages,
                                    verifications,
                                    choices: updated,
                                  });
                                }}
                              >
                                {community.seedIds.map((id) => {
                                  const option = seedsById.get(id);
                                  return option ? (
                                    <option key={id} value={id}>
                                      {option.station.name} ·{' '}
                                      {option.lineName.split(/[（(]/)[0]} ·{' '}
                                      {option.directionLabel} →{' '}
                                      {option.stops.at(-1)?.name ??
                                        option.accessStation.name}
                                    </option>
                                  ) : null;
                                })}
                              </select>
                            </label>
                          ) : (
                            seed && (
                              <p className="community-route-label">
                                {seed.lineName.split(/[（(]/)[0]} ·{' '}
                                {seed.directionLabel}
                                <br />到{' '}
                                {seed.stops.at(-1)?.name ??
                                  seed.accessStation.name}
                              </p>
                            )
                          )}
                          {result?.totalSeconds !== undefined && (
                            <div className="community-breakdown">
                              <strong>
                                门到门约 {formatDuration(result.totalSeconds)}
                              </strong>
                              {result.homeWalkSeconds !== undefined &&
                                result.transitSeconds !== undefined &&
                                result.companyWalkSeconds !== undefined && (
                                  <span>
                                    小区步行{' '}
                                    {formatDuration(result.homeWalkSeconds)} +
                                    公共交通（含候车）
                                    {formatDuration(result.transitSeconds)} +
                                    到公司步行{' '}
                                    {formatDuration(result.companyWalkSeconds)}
                                  </span>
                                )}
                              {result.status === 'over_budget' && (
                                <small>
                                  超出预算{' '}
                                  {formatDuration(
                                    result.totalSeconds - budgetMinutes * 60,
                                  )}
                                </small>
                              )}
                              {result.cached && <small>复用近期核验</small>}
                            </div>
                          )}
                          {result?.message && (
                            <p className="community-hint">{result.message}</p>
                          )}
                          <div className="community-card-actions">
                            <button
                              type="button"
                              onClick={() => {
                                selectCommunity(community.id);
                              }}
                            >
                              <MapPin size={14} />
                              {result?.geometry.length
                                ? '查看完整路线'
                                : '地图定位'}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(busy) || disabled || excluded}
                              onClick={() =>
                                void verify([community], Boolean(result))
                              }
                            >
                              {result &&
                              ['reachable', 'over_budget'].includes(
                                result.status,
                              )
                                ? '更新此路线'
                                : '补查此小区'}
                            </button>
                          </div>
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
              {moreAvailable && (
                <button
                  type="button"
                  className="community-batch"
                  disabled={Boolean(busy) || disabled}
                  onClick={() => void search(true)}
                >
                  加载更多小区（每站最多 60 个）
                </button>
              )}
              {selected.some(
                (group) =>
                  pages[group.id]?.page === 3 && pages[group.id].hasMore,
              ) && (
                <p className="community-hint">
                  部分站点已达到 60
                  个候选上限，未覆盖全部小区；可缩小范围或更换站点。
                </p>
              )}
            </>
          )}
        </>
      )}
      <p className="community-disclaimer">
        仅展示高德住宅小区
        POI，不代表有房出租；暂无租金、户型或房源库存。路线基于小区 POI
        位置，实际楼栋、出入口、候车和路况可能影响通勤。
      </p>
    </section>
  );
}
