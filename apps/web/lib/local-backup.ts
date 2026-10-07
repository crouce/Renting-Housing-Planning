import { validLocation, validSeed, validStop } from './community-core.ts';
import {
  communityChoiceKey,
  COLLECTION_MAX_BYTES,
  FAVORITE_LIMIT,
  IGNORED_LIMIT,
  type CommunityCollection,
  type Favorite,
} from './community-collection.ts';
import type { RememberedPlace, RememberedPreferences } from './local-memory';
import type {
  BoardingStation,
  CommunityVerification,
  TransitStop,
} from './community-types';
import { validDepartureDate } from './departure-date.ts';
import {
  validEntrance,
  ENTRANCE_LIMIT,
  entranceKey,
  type Entrance,
} from './entrances.ts';

export const BACKUP_MAX_BYTES = 1_000_000;
export type BackupPlanner = {
  preferences: RememberedPreferences;
  recentPlaces: RememberedPlace[];
};
export type LocalBackup = {
  format: 'commute-radius-backup';
  version: 1;
  exportedAt: number;
  planner: BackupPlanner | null;
  collection: CommunityCollection;
};
const invalid = () => {
  throw new Error('备份格式或字段不正确，未修改本机数据。');
};
const string = (value: unknown, max = 160): string =>
  typeof value === 'string' && value.length <= max ? value : invalid();
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : invalid();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const list = (value: unknown, max: number): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : invalid();
function stop(value: unknown): TransitStop {
  if (!validStop(value)) return invalid();
  if (
    value.originalLocation !== undefined &&
    !validLocation(value.originalLocation)
  )
    return invalid();
  return {
    id: value.id,
    name: value.name,
    location: value.location,
    ...(value.originalLocation
      ? { originalLocation: value.originalLocation }
      : {}),
  };
}
function seed(value: unknown): BoardingStation {
  if (!validSeed(value)) return invalid();
  return {
    id: string(value.id, 500),
    directionId: string(value.directionId, 500),
    citycode: value.citycode,
    lineId: value.lineId,
    lineName: value.lineName,
    directionLabel: string(value.directionLabel, 500),
    station: stop(value.station),
    accessStation: stop(value.accessStation),
    stops: value.stops.map(stop),
    transitSeconds: number(value.transitSeconds),
    companyWalkSeconds: number(value.companyWalkSeconds),
  };
}
function proof(value: unknown): Omit<CommunityVerification, 'geometry'> {
  const v = record(value);
  if (
    !['reachable', 'over_budget', 'no_route', 'error'].includes(
      String(v.status),
    )
  )
    return invalid();
  const result: Omit<CommunityVerification, 'geometry'> = {
    communityId: string(v.communityId),
    seedId: string(v.seedId, 500),
    checkedAt: number(v.checkedAt),
    cached: false,
    status: v.status as CommunityVerification['status'],
  };
  for (const key of [
    'totalSeconds',
    'homeWalkSeconds',
    'transitSeconds',
    'companyWalkSeconds',
    'walkingMeters',
  ] as const)
    if (v[key] !== undefined) result[key] = number(v[key]);
  // API error text is not needed in backups; only whitelisted timing fields travel.
  return result;
}
function favorite(value: unknown, importing: boolean): Favorite {
  const v = record(value),
    c = record(v.community),
    r = record(v.route);
  const community = {
    ...stop(c),
    address: string(c.address, 1000),
    distanceMeters: number(c.distanceMeters),
    seedIds: [],
  };
  const anchor = stop(v.anchor);
  const date = string(v.date, 10),
    time = string(v.time, 5);
  if (
    !validDepartureDate(date, '0001-01-01') ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    return invalid();
  return {
    id: communityChoiceKey(anchor, community),
    community,
    anchor,
    date,
    time,
    savedAt: number(v.savedAt),
    imported: importing || v.imported === true,
    seed: v.seed === undefined ? undefined : seed(v.seed),
    route: {
      lineName: string(r.lineName, 200),
      directionLabel: string(r.directionLabel, 500),
      boarding: string(r.boarding),
      alighting: string(r.alighting),
    },
    verification:
      v.verification === undefined ? undefined : proof(v.verification),
  };
}
function ignoredKey(value: unknown) {
  const parts = JSON.parse(string(value, 1000));
  if (!Array.isArray(parts) || parts.length !== 3 || !validLocation(parts[1]))
    return invalid();
  return JSON.stringify([string(parts[0]), parts[1], string(parts[2])]);
}
function place(value: unknown): RememberedPlace {
  const v = record(value);
  return {
    ...stop(value),
    district: string(v.district, 500),
    adcode: string(v.adcode, 20),
    address: string(v.address, 1000),
    typecode: string(v.typecode, 100),
  };
}
function planner(value: unknown): BackupPlanner | null {
  if (value === null) return null;
  const v = record(value),
    p = record(v.preferences),
    budget = number(p.budget),
    date = string(p.departureDate, 10),
    time = string(p.departureTime, 5);
  if (
    budget < 20 ||
    budget > 90 ||
    ![500, 1000, 1500].includes(p.stationRadius as number) ||
    !validDepartureDate(date, '0001-01-01') ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    return invalid();
  return {
    preferences: {
      selectedPlace: p.selectedPlace === null ? null : place(p.selectedPlace),
      budget,
      departureDate: date,
      departureTime: time,
      stationRadius: p.stationRadius as 500 | 1000 | 1500,
      selectedStationIds: list(p.selectedStationIds ?? [], 3).map((v) =>
        string(v, 160),
      ),
      selectedLineKeys: list(p.selectedLineKeys ?? [], 8).map((v) =>
        string(v, 500),
      ),
    },
    recentPlaces: list(v.recentPlaces, 5).map(place),
  };
}
export function validateCollectionSize(collection: CommunityCollection) {
  if (
    (collection.entrances?.length ?? 0) > ENTRANCE_LIMIT ||
    collection.favorites.length > FAVORITE_LIMIT ||
    collection.ignored.length > IGNORED_LIMIT ||
    JSON.stringify(collection).length * 2 > COLLECTION_MAX_BYTES
  )
    throw new Error(
      '合并后超出 20 个收藏、100 条排除、40 个入口或约 500 KiB 上限。请先整理记录，未导入任何内容。',
    );
  return collection;
}
function sanitize(value: unknown, importing: boolean): LocalBackup {
  const v = record(value),
    c = record(v.collection);
  if (
    v.format !== 'commute-radius-backup' ||
    v.version !== 1 ||
    c.version !== 1
  )
    return invalid();
  const favorites = list(c.favorites, FAVORITE_LIMIT).map((item) =>
    favorite(item, importing),
  );
  const collection: CommunityCollection = {
    version: 1,
    ...(c.entrances === undefined
      ? {}
      : {
          entrances: list(c.entrances, ENTRANCE_LIMIT).map((value) => {
            if (!validEntrance(value)) return invalid();
            return {
              kind: value.kind,
              id: value.id,
              name: value.name,
              originalLocation: value.originalLocation,
              location: value.location,
            } as Entrance;
          }),
        }),
    favorites: [...new Map(favorites.map((item) => [item.id, item])).values()],
    ignored: [...new Set(list(c.ignored, IGNORED_LIMIT).map(ignoredKey))],
  };
  return {
    format: 'commute-radius-backup',
    version: 1,
    exportedAt: number(v.exportedAt),
    planner: planner(v.planner),
    collection: validateCollectionSize(collection),
  };
}
export function exportLocalBackup(
  current: BackupPlanner | null,
  collection: CommunityCollection,
) {
  const raw = JSON.stringify(
    sanitize(
      {
        format: 'commute-radius-backup',
        version: 1,
        exportedAt: Date.now(),
        planner: current,
        collection,
      },
      false,
    ),
    null,
    2,
  );
  if (new TextEncoder().encode(raw).byteLength > BACKUP_MAX_BYTES)
    throw new Error('备份超过 1 MB，请先整理记录。');
  return raw;
}
export function parseLocalBackup(raw: string): LocalBackup {
  if (new TextEncoder().encode(raw).byteLength > BACKUP_MAX_BYTES)
    throw new Error('备份文件超过 1 MB，未读取或导入。');
  try {
    return sanitize(JSON.parse(raw), true);
  } catch (error) {
    if (error instanceof Error && /上限/.test(error.message)) throw error;
    return invalid();
  }
}
export function mergeBackupCollection(
  current: CommunityCollection,
  incoming: CommunityCollection,
) {
  const retained = new Set(current.favorites.map((item) => item.id));
  return validateCollectionSize({
    version: 1,
    ...(current.entrances || incoming.entrances
      ? {
          entrances: [
            ...new Map(
              [...(incoming.entrances ?? []), ...(current.entrances ?? [])].map(
                (e) => [entranceKey(e), e],
              ),
            ).values(),
          ],
        }
      : {}),
    favorites: [
      ...current.favorites,
      ...incoming.favorites.filter((item) => !retained.has(item.id)),
    ],
    ignored: [...new Set([...current.ignored, ...incoming.ignored])],
  });
}
