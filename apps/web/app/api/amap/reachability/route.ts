import { amapErrorResponse, amapRequest } from '@/lib/amap-server';

type CommuteDirection = 'to' | 'from';
type TransitMode = 'BUS' | 'SUBWAY' | 'LIGHT_RAIL';

type ReachabilityRequest = {
  anchor?: {
    id?: string;
    name?: string;
    location?: string;
  };
  budgetMinutes?: number;
  departureDate?: string;
  departureTime?: string;
  accessStations?: Array<{
    id?: string;
    name?: string;
    location?: string;
    citycode?: string;
    distanceMeters?: number;
    allowedLines?: string[];
  }>;
};

type AccessStation = {
  id: string;
  name: string;
  location: string;
  citycode: string;
  distanceMeters: number;
  allowedLines: string[];
};

type AccessStationWithWalk = AccessStation & {
  walkingDistanceMeters: number;
  walkingDurationSeconds: number;
  remainingTransitSeconds: number;
};

type AMapPoi = {
  id?: string;
  parent?: string;
  name?: string;
  location?: string;
  distance?: string;
  typecode?: string;
  address?: string;
  citycode?: string;
  adcode?: string;
};

type AroundResponse = {
  status: string;
  info: string;
  infocode: string;
  pois?: AMapPoi[];
};

type TransitResponse = {
  status: string;
  info: string;
  infocode: string;
  route?: {
    transits?: Array<{
      cost?: { duration?: string };
      segments?: Array<{
        bus?: { buslines?: Array<{ name?: string }> };
      }>;
    }>;
  };
};

type WalkingResponse = {
  status: string;
  info: string;
  infocode: string;
  route?: {
    paths?: Array<{
      distance?: string;
      cost?: { duration?: string };
    }>;
  };
};

type CandidateStation = {
  id: string;
  logicalId: string;
  name: string;
  location: string;
  mode: TransitMode;
  address: string;
  lines: string[];
  citycode: string;
  adcode: string;
};

type ReachableStation = CandidateStation & {
  transitDurationSeconds: number;
  transitDurationMinutes: number;
  durationSeconds: number;
  durationMinutes: number;
  straightLineMeters: number;
  segmentCount: number;
  routeLines: string[];
  matchedLines: string[];
  accessStation: {
    id: string;
    name: string;
    walkingDistanceMeters: number;
    walkingMinutes: number;
    remainingTransitSeconds: number;
    remainingTransitMinutes: number;
  };
};

type AccessStationBudget = {
  id: string;
  name: string;
  walkingDistanceMeters: number;
  walkingMinutes: number;
  remainingTransitMinutes: number;
  usable: boolean;
};

type DirectionReachability = {
  direction: CommuteDirection;
  routeCheckCount: number;
  checkedCount: number;
  failedCount: number;
  reachableCount: number;
  fastestCandidateMinutes: number | null;
  farthest: ReachableStation | null;
  nearMisses: ReachableStation[];
  stations: ReachableStation[];
};

type ReachabilityResult = {
  sampled: true;
  budgetMinutes: number;
  scanRadiusMeters: number;
  candidateCount: number;
  routeCheckCount: number;
  selectedAccessStationCount: number;
  accessStationBudgets: AccessStationBudget[];
  directions: {
    to: DirectionReachability;
    from: DirectionReachability;
  };
};

type CacheEntry = { expiresAt: number; value: ReachabilityResult };

const locationPattern = /^-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const cache = new Map<string, CacheEntry>();

function parseLocation(location: string): [number, number] {
  const [longitude, latitude] = location.split(',').map(Number);
  return [longitude, latitude];
}

function formatLocation([longitude, latitude]: [number, number]) {
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
}

function destinationPoint(
  origin: [number, number],
  distanceMeters: number,
  bearingDegrees: number,
): [number, number] {
  const earthRadius = 6_371_000;
  const [longitude, latitude] = origin;
  const angularDistance = distanceMeters / earthRadius;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeRadians = (longitude * Math.PI) / 180;
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) -
        Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    );

  return [(nextLongitude * 180) / Math.PI, (nextLatitude * 180) / Math.PI];
}

function straightLineDistance(from: string, to: string) {
  const earthRadius = 6_371_000;
  const [fromLongitude, fromLatitude] = parseLocation(from).map(
    (value) => (value * Math.PI) / 180,
  );
  const [toLongitude, toLatitude] = parseLocation(to).map(
    (value) => (value * Math.PI) / 180,
  );
  const latitudeDelta = toLatitude - fromLatitude;
  const longitudeDelta = toLongitude - fromLongitude;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return Math.round(
    2 *
      earthRadius *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)),
  );
}

function stationMode(typecode = ''): TransitMode {
  if (typecode.startsWith('1505')) return 'SUBWAY';
  if (typecode.startsWith('1506')) return 'LIGHT_RAIL';
  return 'BUS';
}

function parseTransitLines(address: string) {
  return [...new Set(address.split(/[;；]/).map((line) => line.trim()))].filter(
    Boolean,
  );
}

function normalizeLineName(line: string) {
  return line
    .split('(')[0]
    .replaceAll('地铁', '')
    .replaceAll(/\s/g, '')
    .toLowerCase();
}

function routeMatchesAllowedLines(
  routeLines: string[],
  allowedLines: string[],
) {
  if (allowedLines.length === 0) return true;
  const normalizedRouteLines = routeLines.map(normalizeLineName);
  return allowedLines.some((allowedLine) => {
    const normalizedAllowedLine = normalizeLineName(allowedLine);
    return normalizedRouteLines.some(
      (routeLine) =>
        routeLine.includes(normalizedAllowedLine) ||
        normalizedAllowedLine.includes(routeLine),
    );
  });
}

function selectEvenly<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => {
    const itemIndex = Math.floor((index * items.length) / limit);
    return items[itemIndex];
  });
}

function normalizePoi(poi: AMapPoi): CandidateStation | null {
  if (
    !poi.id ||
    !poi.name ||
    !poi.location ||
    !locationPattern.test(poi.location)
  ) {
    return null;
  }

  const address = poi.address ?? '';
  return {
    id: poi.id,
    logicalId: poi.parent || poi.id,
    name: poi.name.replace(/\(公交站\)$/, ''),
    location: poi.location,
    mode: stationMode(poi.typecode),
    address,
    lines: parseTransitLines(address),
    citycode: String(poi.citycode ?? ''),
    adcode: String(poi.adcode ?? ''),
  };
}

async function findStationsAround(location: string, radius: number) {
  const result = await amapRequest<AroundResponse>(
    '/v5/place/around',
    new URLSearchParams({
      location,
      radius: String(radius),
      types: '150500|150600|150700',
      sortrule: 'distance',
      page_size: '25',
      show_fields: 'children',
    }),
  );

  return (result.pois ?? [])
    .map(normalizePoi)
    .filter((station): station is CandidateStation => Boolean(station));
}

function selectSectorCandidates(stations: CandidateStation[]) {
  return stations[0] ? [stations[0]] : [];
}

async function runThrottled<T, R>(
  items: T[],
  intervalMilliseconds: number,
  worker: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  for (const [index, item] of items.entries()) {
    results.push(await worker(item));
    if (index < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
    }
  }
  return results;
}

async function planWalking(
  anchor: NonNullable<ReachabilityRequest['anchor']>,
  accessStation: AccessStation,
  budgetSeconds: number,
): Promise<AccessStationWithWalk | null> {
  const params = new URLSearchParams({
    origin: anchor.location!,
    destination: accessStation.location,
    origin_id: anchor.id!,
    destination_id: accessStation.id,
    alternative_route: '1',
    show_fields: 'cost',
  });

  try {
    const result = await amapRequest<WalkingResponse>(
      '/v5/direction/walking',
      params,
      { retries: 0, timeoutMilliseconds: 8_000 },
    );
    const paths = (result.route?.paths ?? [])
      .map((path) => ({
        distanceMeters: Number(path.distance ?? 0),
        durationSeconds: Number(path.cost?.duration ?? 0),
      }))
      .filter(
        (path) =>
          path.distanceMeters >= 0 &&
          Number.isFinite(path.durationSeconds) &&
          path.durationSeconds > 0,
      )
      .sort((left, right) => left.durationSeconds - right.durationSeconds);
    const best = paths[0];
    if (!best) return null;

    return {
      ...accessStation,
      walkingDistanceMeters: Math.round(best.distanceMeters),
      walkingDurationSeconds: Math.ceil(best.durationSeconds),
      remainingTransitSeconds: Math.max(
        0,
        budgetSeconds - Math.ceil(best.durationSeconds),
      ),
    };
  } catch {
    return null;
  }
}

async function planTransit(
  station: CandidateStation,
  accessStation: AccessStationWithWalk,
  direction: CommuteDirection,
  departureDate: string,
  departureTime: string,
): Promise<{
  transitDurationSeconds: number;
  durationSeconds: number;
  segmentCount: number;
  routeLines: string[];
  matchedLines: string[];
  accessStation: ReachableStation['accessStation'];
} | null> {
  if (!station.citycode || !accessStation.citycode) return null;

  const toAnchor = direction === 'to';
  const params = new URLSearchParams({
    origin: toAnchor ? station.location : accessStation.location,
    destination: toAnchor ? accessStation.location : station.location,
    city1: toAnchor ? station.citycode : accessStation.citycode,
    city2: toAnchor ? accessStation.citycode : station.citycode,
    originpoi: toAnchor ? station.id : accessStation.id,
    destinationpoi: toAnchor ? accessStation.id : station.id,
    strategy: '8',
    AlternativeRoute: '3',
    date: departureDate,
    time: departureTime.replace(':', '-'),
    show_fields: 'cost',
  });

  try {
    const result = await amapRequest<TransitResponse>(
      '/v5/direction/transit/integrated',
      params,
      { retries: 0, timeoutMilliseconds: 8_000 },
    );
    const routes = (result.route?.transits ?? [])
      .map((route) => {
        const routeLines = [
          ...new Set(
            (route.segments ?? []).flatMap((segment) =>
              (segment.bus?.buslines ?? [])
                .map((busline) => busline.name?.trim() ?? '')
                .filter(Boolean),
            ),
          ),
        ];
        const matchedLines = accessStation.allowedLines.filter((allowedLine) =>
          routeMatchesAllowedLines(routeLines, [allowedLine]),
        );
        return {
          transitDurationSeconds: Number(route.cost?.duration ?? 0),
          durationSeconds:
            Number(route.cost?.duration ?? 0) +
            accessStation.walkingDurationSeconds,
          segmentCount: route.segments?.length ?? 0,
          routeLines,
          matchedLines,
          accessStation: {
            id: accessStation.id,
            name: accessStation.name,
            walkingDistanceMeters: accessStation.walkingDistanceMeters,
            walkingMinutes: Math.ceil(
              accessStation.walkingDurationSeconds / 60,
            ),
            remainingTransitSeconds: accessStation.remainingTransitSeconds,
            remainingTransitMinutes: Math.floor(
              accessStation.remainingTransitSeconds / 60,
            ),
          },
        };
      })
      .filter(
        (route) =>
          route.transitDurationSeconds > 0 &&
          routeMatchesAllowedLines(
            route.routeLines,
            accessStation.allowedLines,
          ),
      )
      .sort((left, right) => left.durationSeconds - right.durationSeconds);

    return routes[0] ?? null;
  } catch {
    return null;
  }
}

async function evaluateDirection(
  candidates: CandidateStation[],
  activeAccessStations: AccessStationWithWalk[],
  direction: CommuteDirection,
  departureDate: string,
  departureTime: string,
  anchorLocation: string,
): Promise<DirectionReachability> {
  const routePairs = candidates.flatMap((station) =>
    activeAccessStations.map((accessStation) => ({ station, accessStation })),
  );
  const plannedPairs = await runThrottled(
    routePairs,
    450,
    async ({ station, accessStation }) => ({
      station,
      route: await planTransit(
        station,
        accessStation,
        direction,
        departureDate,
        departureTime,
      ),
    }),
  );
  const validPairs = plannedPairs.filter(
    (item): item is typeof item & { route: NonNullable<typeof item.route> } =>
      Boolean(item.route),
  );
  const bestByStation = new Map<string, (typeof validPairs)[number]>();
  for (const item of validPairs) {
    const existing = bestByStation.get(item.station.logicalId);
    if (
      !existing ||
      item.route.durationSeconds < existing.route.durationSeconds
    ) {
      bestByStation.set(item.station.logicalId, item);
    }
  }
  const successful = [...bestByStation.values()];
  const evaluated = successful.map<ReachableStation>(({ station, route }) => ({
    ...station,
    transitDurationSeconds: route.transitDurationSeconds,
    transitDurationMinutes: Math.ceil(route.transitDurationSeconds / 60),
    durationSeconds: route.durationSeconds,
    durationMinutes: Math.ceil(route.durationSeconds / 60),
    straightLineMeters: straightLineDistance(anchorLocation, station.location),
    segmentCount: route.segmentCount,
    routeLines: route.routeLines,
    matchedLines: route.matchedLines,
    accessStation: route.accessStation,
  }));
  const reachable = evaluated
    .filter(
      (station) =>
        station.transitDurationSeconds <=
        station.accessStation.remainingTransitSeconds,
    )
    .sort((left, right) => right.straightLineMeters - left.straightLineMeters);
  const nearMisses = evaluated
    .filter(
      (station) =>
        station.transitDurationSeconds >
        station.accessStation.remainingTransitSeconds,
    )
    .sort((left, right) => left.durationSeconds - right.durationSeconds)
    .slice(0, 3);

  return {
    direction,
    routeCheckCount: routePairs.length,
    checkedCount: successful.length,
    failedCount: candidates.length - successful.length,
    reachableCount: reachable.length,
    fastestCandidateMinutes:
      successful.length > 0
        ? Math.ceil(
            Math.min(...successful.map((item) => item.route.durationSeconds)) /
              60,
          )
        : null,
    farthest: reachable[0] ?? null,
    nearMisses,
    stations: reachable.slice(0, 12),
  };
}

export async function POST(request: Request) {
  let body: ReachabilityRequest;
  try {
    body = (await request.json()) as ReachabilityRequest;
  } catch {
    return Response.json(
      { error: { code: 'INVALID_BODY', message: '请求内容不是有效的 JSON。' } },
      { status: 400 },
    );
  }

  const anchor = body.anchor;
  const budgetMinutes = Number(body.budgetMinutes);
  const departureDate = body.departureDate ?? '';
  const departureTime = body.departureTime ?? '';
  const requestedAccessStations = body.accessStations ?? [];

  if (
    !anchor?.id ||
    !anchor.name ||
    !anchor.location ||
    !locationPattern.test(anchor.location) ||
    !Number.isInteger(budgetMinutes) ||
    budgetMinutes < 20 ||
    budgetMinutes > 90 ||
    !datePattern.test(departureDate) ||
    !timePattern.test(departureTime) ||
    requestedAccessStations.length < 1 ||
    requestedAccessStations.length > 3
  ) {
    return Response.json(
      {
        error: { code: 'INVALID_PARAMETERS', message: '通勤计算参数不完整。' },
      },
      { status: 400 },
    );
  }

  const validatedAnchor = {
    id: anchor.id,
    name: anchor.name,
    location: anchor.location,
  };
  const invalidAccessStation = requestedAccessStations.some(
    (station) =>
      !station.id ||
      !station.name ||
      !station.location ||
      !locationPattern.test(station.location) ||
      !station.citycode ||
      !Number.isFinite(Number(station.distanceMeters)) ||
      Number(station.distanceMeters) < 0 ||
      Number(station.distanceMeters) > 3_000 ||
      !Array.isArray(station.allowedLines) ||
      station.allowedLines.length > 8 ||
      station.allowedLines.some(
        (line) =>
          typeof line !== 'string' || line.length < 1 || line.length > 80,
      ),
  );
  if (invalidAccessStation) {
    return Response.json(
      {
        error: {
          code: 'INVALID_ACCESS_STATIONS',
          message: '选定站点或线路参数不正确。',
        },
      },
      { status: 400 },
    );
  }
  const accessStations: AccessStation[] = requestedAccessStations.map(
    (station) => ({
      id: station.id!,
      name: station.name!,
      location: station.location!,
      citycode: station.citycode!,
      distanceMeters: Math.round(Number(station.distanceMeters)),
      allowedLines: [
        ...new Set(station.allowedLines!.map((line) => line.trim())),
      ],
    }),
  );
  const cacheKey = [
    anchor.id,
    anchor.location,
    budgetMinutes,
    departureDate,
    departureTime,
    ...accessStations
      .map(
        (station) =>
          `${station.id}:${station.allowedLines.slice().sort().join(',')}`,
      )
      .sort(),
  ].join('|');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json({ ...cached.value, cached: true });
  }

  try {
    const walkingPlans = await runThrottled(
      accessStations,
      250,
      async (accessStation) =>
        planWalking(validatedAnchor, accessStation, budgetMinutes * 60),
    );
    const plannedAccessStations = walkingPlans.filter(
      (station): station is AccessStationWithWalk => Boolean(station),
    );
    if (plannedAccessStations.length === 0) {
      return Response.json(
        {
          error: {
            code: 'NO_WALKING_ROUTE',
            message: '无法取得所选接驳站点的步行路线。',
          },
        },
        { status: 422 },
      );
    }
    const activeAccessStations = plannedAccessStations.filter(
      (station) => station.remainingTransitSeconds > 0,
    );
    const maxRemainingTransitMinutes = Math.max(
      0,
      ...plannedAccessStations.map((station) =>
        Math.floor(station.remainingTransitSeconds / 60),
      ),
    );
    const scanRadiusMeters = Math.min(
      8_000,
      Math.max(3_000, maxRemainingTransitMinutes * 80),
    );
    const sampleSearchRadius = Math.min(
      4_000,
      Math.max(2_000, Math.round(scanRadiusMeters * 0.28)),
    );
    const anchorCoordinates = parseLocation(anchor.location);
    const sectorCenters = Array.from({ length: 8 }, (_, index) =>
      formatLocation(
        destinationPoint(anchorCoordinates, scanRadiusMeters, index * 45),
      ),
    );
    const sectors = await runThrottled(sectorCenters, 450, async (center) => {
      try {
        return await findStationsAround(center, sampleSearchRadius);
      } catch {
        return [];
      }
    });
    const anchorCitycode =
      accessStations.find((station) => station.citycode)?.citycode ??
      sectors.flat().find((station) => station.citycode)?.citycode ??
      '';
    const rawCandidates = sectors.flatMap(selectSectorCandidates);
    const candidateMap = new Map<string, CandidateStation>();
    for (const station of rawCandidates) {
      if (!candidateMap.has(station.logicalId)) {
        candidateMap.set(station.logicalId, station);
      }
      if (candidateMap.size >= 8) break;
    }
    for (const station of activeAccessStations) {
      if (!station.citycode) station.citycode = anchorCitycode;
    }
    const candidateLimit = Math.max(
      4,
      Math.floor(12 / activeAccessStations.length),
    );
    const candidates = selectEvenly([...candidateMap.values()], candidateLimit);

    const to = await evaluateDirection(
      candidates,
      activeAccessStations,
      'to',
      departureDate,
      departureTime,
      validatedAnchor.location,
    );
    const from = await evaluateDirection(
      candidates,
      activeAccessStations,
      'from',
      departureDate,
      departureTime,
      validatedAnchor.location,
    );
    const result: ReachabilityResult = {
      sampled: true,
      budgetMinutes,
      scanRadiusMeters,
      candidateCount: candidates.length,
      routeCheckCount: to.routeCheckCount + from.routeCheckCount,
      selectedAccessStationCount: accessStations.length,
      accessStationBudgets: plannedAccessStations.map((station) => ({
        id: station.id,
        name: station.name,
        walkingDistanceMeters: station.walkingDistanceMeters,
        walkingMinutes: Math.ceil(station.walkingDurationSeconds / 60),
        remainingTransitMinutes: Math.floor(
          station.remainingTransitSeconds / 60,
        ),
        usable: station.remainingTransitSeconds > 0,
      })),
      directions: { to, from },
    };

    cache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: result });
    return Response.json(result);
  } catch (error) {
    return amapErrorResponse(error);
  }
}
