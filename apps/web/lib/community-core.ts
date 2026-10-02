import { matchesDirectLine } from './reachability-core.ts';
import type {
  BoardingStation,
  Community,
  CommunityGeometry,
  CommunityVerification,
  TransitStop,
} from './community-types';

export function validLocation(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?$/.test(value)
  )
    return false;
  const [lng, lat] = value.split(',').map(Number);
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}
export function validStop(value: unknown): value is TransitStop {
  const stop = value as TransitStop | null;
  return Boolean(
    stop &&
    typeof stop.id === 'string' &&
    stop.id.length > 0 &&
    stop.id.length <= 160 &&
    typeof stop.name === 'string' &&
    stop.name.length > 0 &&
    stop.name.length <= 160 &&
    validLocation(stop.location),
  );
}
export function validSeed(value: unknown): value is BoardingStation {
  const seed = value as BoardingStation | null;
  return Boolean(
    seed &&
    typeof seed.id === 'string' &&
    seed.id.length <= 500 &&
    validStop(seed.station) &&
    validStop(seed.accessStation) &&
    typeof seed.citycode === 'string' &&
    /^\d{2,6}$/.test(seed.citycode) &&
    typeof seed.lineId === 'string' &&
    seed.lineId.length <= 160 &&
    typeof seed.lineName === 'string' &&
    seed.lineName.length <= 200 &&
    Array.isArray(seed.stops) &&
    seed.stops.length >= 2 &&
    seed.stops.length <= 200 &&
    seed.stops.every(validStop) &&
    seed.stops[0].id === seed.station.id &&
    validLocation(seed.stops.at(-1)?.location),
  );
}
export function mergeCommunities(previous: Community[], incoming: Community[]) {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) {
    const old = byId.get(item.id);
    byId.set(
      item.id,
      old
        ? {
            ...item,
            distanceMeters: Math.min(old.distanceMeters, item.distanceMeters),
            seedIds:
              old.location === item.location
                ? [...new Set([...old.seedIds, ...item.seedIds])]
                : item.seedIds,
          }
        : item,
    );
  }
  return [...byId.values()].sort(
    (a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id),
  );
}

type Walking = {
  duration?: string;
  cost?: { duration?: string };
  distance?: string;
  steps?: Array<{ duration?: string; polyline?: unknown }>;
};
type BusLine = {
  id?: string;
  name?: string;
  polyline?: unknown;
  departure_stop?: Partial<TransitStop>;
  arrival_stop?: Partial<TransitStop>;
  via_stops?: Partial<TransitStop>[];
};
export type CommunityTransit = {
  cost?: { duration?: string };
  segments?: Array<{
    walking?: Walking;
    railway?: unknown;
    taxi?: unknown;
    bus?: { buslines?: BusLine[] };
  }>;
};
function numeric(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}
function walkSeconds(walking?: Walking) {
  if (!walking || Object.keys(walking).length === 0) return 0;
  const duration = numeric(walking.cost?.duration ?? walking.duration);
  if (duration !== undefined) return duration;
  const steps = walking.steps ?? [];
  if (
    steps.length &&
    steps.every((step) => numeric(step.duration) !== undefined)
  )
    return steps.reduce((sum, step) => sum + Number(step.duration), 0);
  return numeric(walking.distance) === 0 ? 0 : undefined;
}
export function parsePath(value: unknown): Array<[number, number]> {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value && 'polyline' in value
        ? value.polyline
        : '';
  return typeof text === 'string'
    ? text
        .split(';')
        .filter(validLocation)
        .map((point) => point.split(',').map(Number) as [number, number])
    : [];
}

/** Inspect the complete home-to-company plan: never add station baseline times twice. */
export function verifyCommunityRoutes(
  transits: CommunityTransit[],
  seed: BoardingStation,
  communityId: string,
  budgetSeconds: number,
): CommunityVerification {
  const base = {
    communityId,
    seedId: seed.id,
    geometry: [] as CommunityGeometry[],
    checkedAt: Date.now(),
    cached: false,
  };
  const matches = transits.flatMap((route) => {
    const segments = route.segments ?? [];
    const rideIndexes = segments.flatMap((segment, index) =>
      segment.bus?.buslines?.length ? [index] : [],
    );
    if (
      rideIndexes.length !== 1 ||
      segments.some((segment) =>
        [segment.taxi, segment.railway].some(
          (value) =>
            value && typeof value === 'object' && Object.keys(value).length,
        ),
      )
    )
      return [];
    const rideIndex = rideIndexes[0];
    const line = segments[rideIndex].bus!.buslines!.find((line) =>
      matchesDirectLine(line, {
        id: seed.lineId,
        name: seed.lineName,
        stops: seed.stops,
        boardIndex: 0,
        alightIndex: seed.stops.length - 1,
      }),
    );
    const total = numeric(route.cost?.duration);
    if (!line || total === undefined || total <= 0) return [];
    let homeWalk = 0;
    let companyWalk = 0;
    let hasBreakdown = true;
    let walkingMeters = 0;
    const geometry: CommunityGeometry[] = [];
    for (const [index, segment] of segments.entries()) {
      const seconds = walkSeconds(segment.walking);
      if (seconds === undefined) hasBreakdown = false;
      else if (index <= rideIndex) homeWalk += seconds;
      else companyWalk += seconds;
      walkingMeters += numeric(segment.walking?.distance) ?? 0;
      for (const step of segment.walking?.steps ?? []) {
        const path = parsePath(step.polyline);
        if (path.length > 1) geometry.push({ mode: 'WALK', path, stops: [] });
      }
      if (index === rideIndex) {
        const stops = [
          { ...line.departure_stop, role: 'BOARD' as const },
          ...(line.via_stops ?? []).map((stop) => ({
            ...stop,
            role: 'VIA' as const,
          })),
          { ...line.arrival_stop, role: 'ALIGHT' as const },
        ].filter(
          (stop): stop is TransitStop & { role: 'BOARD' | 'VIA' | 'ALIGHT' } =>
            validStop(stop),
        );
        const path = parsePath(line.polyline);
        if (path.length > 1) geometry.push({ mode: 'TRANSIT', path, stops });
      }
    }
    if (homeWalk + companyWalk > total) hasBreakdown = false;
    return [
      {
        ...base,
        status:
          total <= budgetSeconds
            ? ('reachable' as const)
            : ('over_budget' as const),
        totalSeconds: total,
        homeWalkSeconds: hasBreakdown ? homeWalk : undefined,
        companyWalkSeconds: hasBreakdown ? companyWalk : undefined,
        transitSeconds: hasBreakdown
          ? total - homeWalk - companyWalk
          : undefined,
        walkingMeters,
        geometry,
        message: hasBreakdown
          ? undefined
          : '高德未提供完整分段耗时；总耗时已包含两端步行，明细不作估算。',
      },
    ];
  });
  return (
    matches.sort((a, b) => a.totalSeconds - b.totalSeconds)[0] ?? {
      ...base,
      status: 'no_route',
      message:
        '未返回符合指定线路、方向和上下车站的直达方案，不代表该小区不可达。',
    }
  );
}
