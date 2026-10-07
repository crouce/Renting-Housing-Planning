import type {
  BoardingStation,
  Community,
  CommunityVerification,
  TransitStop,
} from './community-types';
import {
  applyEntrance,
  changeEntrance,
  ENTRANCE_LIMIT,
  validEntrance,
  type Entrance,
  type EntranceKind,
} from './entrances.ts';

export const COLLECTION_KEY = 'commute-radius:community-collection:v1';
export const FAVORITE_LIMIT = 20;
export const IGNORED_LIMIT = 100;
export const COLLECTION_MAX_BYTES = 512_000;
export type Favorite = {
  id: string;
  community: Community;
  anchor: TransitStop;
  savedAt: number;
  seed?: BoardingStation;
  imported?: boolean;
  date: string;
  time: string;
  route: {
    lineName: string;
    directionLabel: string;
    boarding: string;
    alighting: string;
  };
  verification?: Omit<CommunityVerification, 'geometry'>;
};
export type CommunityCollection = {
  entrances?: Entrance[];
  version: 1;
  favorites: Favorite[];
  ignored: string[];
};
export const emptyCollection = (): CommunityCollection => ({
  version: 1,
  favorites: [],
  ignored: [],
});
export function communityChoiceKey(
  anchor: TransitStop,
  community: Pick<Community, 'id'>,
) {
  return JSON.stringify([anchor.id, anchor.location, community.id]);
}
export function makeFavorite(
  community: Community,
  anchor: TransitStop,
  seed: BoardingStation,
  date: string,
  time: string,
  verification?: CommunityVerification,
): Favorite {
  const proof = verification
    ? {
        communityId: verification.communityId,
        seedId: verification.seedId,
        status: verification.status,
        checkedAt: verification.checkedAt,
        cached: verification.cached,
        totalSeconds: verification.totalSeconds,
        homeWalkSeconds: verification.homeWalkSeconds,
        transitSeconds: verification.transitSeconds,
        companyWalkSeconds: verification.companyWalkSeconds,
        walkingMeters: verification.walkingMeters,
        message: verification.message?.slice(0, 500),
      }
    : undefined;
  return {
    id: communityChoiceKey(anchor, community),
    community: { ...community, seedIds: [] },
    anchor: {
      id: anchor.id,
      name: anchor.name,
      location: anchor.location,
      originalLocation: anchor.originalLocation,
    },
    date,
    time,
    savedAt: Date.now(),
    seed: {
      id: seed.id,
      directionId: seed.directionId,
      citycode: seed.citycode,
      lineId: seed.lineId,
      lineName: seed.lineName,
      directionLabel: seed.directionLabel,
      station: { ...seed.station },
      accessStation: { ...seed.accessStation },
      stops: seed.stops.map((stop) => ({
        id: stop.id,
        name: stop.name,
        location: stop.location,
      })),
      transitSeconds: seed.transitSeconds,
      companyWalkSeconds: seed.companyWalkSeconds,
    },
    route: {
      lineName: seed.lineName,
      directionLabel: seed.directionLabel,
      boarding: seed.station.name,
      alighting: seed.stops.at(-1)?.name ?? seed.accessStation.name,
    },
    verification: proof,
  };
}
export function addFavorite(
  collection: CommunityCollection,
  item: Favorite,
): CommunityCollection {
  if (
    !collection.favorites.some((saved) => saved.id === item.id) &&
    collection.favorites.length >= FAVORITE_LIMIT
  )
    throw new Error('最多收藏 20 个小区，请先移除不再考虑的收藏。');
  const next = {
    ...collection,
    favorites: [
      item,
      ...collection.favorites.filter((saved) => saved.id !== item.id),
    ],
  };
  if (JSON.stringify(next).length * 2 > COLLECTION_MAX_BYTES)
    throw new Error('收藏空间不足，请先移除部分记录。');
  return next;
}
export function setIgnored(
  collection: CommunityCollection,
  id: string,
  ignored: boolean,
): CommunityCollection {
  if (
    ignored &&
    !collection.ignored.includes(id) &&
    collection.ignored.length >= IGNORED_LIMIT
  )
    throw new Error('暂不考虑最多记住 100 个小区，请先恢复部分记录。');
  const next = {
    ...collection,
    ignored: ignored
      ? [...new Set([...collection.ignored, id])]
      : collection.ignored.filter((item) => item !== id),
  };
  if (JSON.stringify(next).length * 2 > COLLECTION_MAX_BYTES)
    throw new Error('收藏与暂不考虑的空间不足，请先移除或恢复部分记录。');
  return next;
}
export function currentFavoriteProof(
  item: Favorite,
  anchor: TransitStop | null,
  date: string,
  time: string,
  now = Date.now(),
) {
  const v = item.verification;
  const today = new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
  return Boolean(
    anchor &&
    !item.imported &&
    item.anchor.id === anchor.id &&
    item.anchor.location === anchor.location &&
    item.date === date &&
    date >= today &&
    item.time === time &&
    v &&
    typeof v.totalSeconds === 'number' &&
    Number.isFinite(v.totalSeconds) &&
    v.totalSeconds >= 0 &&
    v.checkedAt <= now &&
    now - v.checkedAt < 600_000 &&
    ['reachable', 'over_budget'].includes(v.status),
  );
}
export function parseCollection(raw: string | null): CommunityCollection {
  if (!raw || raw.length * 2 > COLLECTION_MAX_BYTES) return emptyCollection();
  try {
    const value = JSON.parse(raw) as CommunityCollection;
    const place = (p: TransitStop) =>
      p &&
      typeof p.id === 'string' &&
      typeof p.name === 'string' &&
      typeof p.location === 'string';
    if (
      value.version !== 1 ||
      !Array.isArray(value.favorites) ||
      !Array.isArray(value.ignored)
    )
      return emptyCollection();
    const favorites = value.favorites.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        place(item.community) &&
        place(item.anchor) &&
        typeof item.date === 'string' &&
        typeof item.time === 'string' &&
        Number.isFinite(item.savedAt) &&
        item.route &&
        ['lineName', 'directionLabel', 'boarding', 'alighting'].every(
          (key) =>
            typeof item.route[key as keyof Favorite['route']] === 'string',
        ) &&
        (!item.verification || Number.isFinite(item.verification.checkedAt)),
    );
    return {
      version: 1,
      ...(Array.isArray(value.entrances)
        ? {
            entrances: value.entrances
              .filter(validEntrance)
              .slice(0, ENTRANCE_LIMIT),
          }
        : {}),
      favorites: [
        ...new Map(favorites.map((item) => [item.id, item])).values(),
      ].slice(0, FAVORITE_LIMIT),
      ignored: [
        ...new Set(value.ignored.filter((id) => typeof id === 'string')),
      ].slice(0, IGNORED_LIMIT),
    };
  } catch {
    return emptyCollection();
  }
}

export function setCollectionEntrance(
  collection: CommunityCollection,
  kind: EntranceKind,
  place: TransitStop,
  location: string,
): CommunityCollection {
  const entrances = changeEntrance(
    collection.entrances ?? [],
    kind,
    place,
    location,
  );
  const favorites = collection.favorites.map((item) => {
    const target = kind === 'company' ? item.anchor : item.community;
    if (
      target.id !== place.id ||
      (target.originalLocation ?? target.location) !==
        (place.originalLocation ?? place.location)
    )
      return item;
    const updated = applyEntrance(target, kind, entrances);
    if (updated.location === target.location) return item;
    const next = {
      ...item,
      ...(kind === 'company'
        ? { anchor: updated }
        : { community: { ...item.community, ...updated } }),
      verification: undefined,
    };
    return { ...next, id: communityChoiceKey(next.anchor, next.community) };
  });
  const next = {
    ...collection,
    entrances,
    favorites: [...new Map(favorites.map((f) => [f.id, f])).values()],
  };
  if (JSON.stringify(next).length * 2 > COLLECTION_MAX_BYTES)
    throw new Error('本机收藏与入口记录空间不足，请先整理。');
  return next;
}
