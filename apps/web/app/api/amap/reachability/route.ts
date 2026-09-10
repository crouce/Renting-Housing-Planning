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
    availableLines?: string[];
    allowedLines?: string[];
  }>;
};

type AccessStation = {
  id: string;
  name: string;
  location: string;
  citycode: string;
  distanceMeters: number;
  availableLines: string[];
  allowedLines: string[];
};

type AccessStationWithWalk = AccessStation & {
  walkingDistanceMeters: number;
  walkingDurationSeconds: number;
  remainingTransitSeconds: number;
};

type AMapBusStop = {
  id?: string;
  name?: string;
  location?: string;
  sequence?: string;
};

type AMapBusLine = {
  id?: string;
  name?: string;
  type?: string;
  citycode?: string;
  start_stop?: string;
  end_stop?: string;
  busstops?: AMapBusStop[];
};

type BusLineResponse = {
  status: string;
  info: string;
  infocode: string;
  buslines?: AMapBusLine[];
};

type TransitResponse = {
  status: string;
  info: string;
  infocode: string;
  route?: {
    transits?: Array<{
      cost?: { duration?: string };
      segments?: Array<{
        walking?: {
          steps?: Array<{ polyline?: unknown }>;
        };
        bus?: {
          buslines?: Array<{ name?: string; polyline?: unknown }>;
        };
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

type RouteGeometrySegment = {
  mode: 'WALK' | 'TRANSIT';
  path: Array<[number, number]>;
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
  routeGeometry: RouteGeometrySegment[];
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
  candidateSource: 'transit_lines';
  budgetMinutes: number;
  networkSpanMeters: number;
  candidateCount: number;
  lineQueryCount: number;
  expandedLineCount: number;
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

function normalizeLineName(line: string) {
  return line
    .split('(')[0]
    .replaceAll('地铁', '')
    .replaceAll(/\s/g, '')
    .toLowerCase();
}

function lineMode(line: AMapBusLine): TransitMode {
  const description = `${line.type ?? ''} ${line.name ?? ''}`;
  if (/有轨电车|轻轨/.test(description)) return 'LIGHT_RAIL';
  if (/地铁|轨道交通/.test(description)) return 'SUBWAY';
  return 'BUS';
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

function polylineText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'polyline' in value &&
    typeof value.polyline === 'string'
  ) {
    return value.polyline;
  }
  return '';
}

function parsePolyline(value: unknown) {
  return polylineText(value)
    .split(';')
    .map((point) => point.split(',').map(Number))
    .filter(
      (point): point is [number, number] =>
        point.length === 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    );
}

function collectRouteGeometry(
  segments: NonNullable<
    NonNullable<TransitResponse['route']>['transits']
  >[number]['segments'],
) {
  const geometry: RouteGeometrySegment[] = [];
  for (const segment of segments ?? []) {
    for (const step of segment.walking?.steps ?? []) {
      const path = parsePolyline(step.polyline);
      if (path.length > 1) geometry.push({ mode: 'WALK', path });
    }
    for (const busline of segment.bus?.buslines ?? []) {
      const path = parsePolyline(busline.polyline);
      if (path.length > 1) geometry.push({ mode: 'TRANSIT', path });
    }
  }
  return geometry;
}

function selectEvenly<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => {
    const itemIndex = Math.floor((index * items.length) / limit);
    return items[itemIndex];
  });
}

async function expandTransitLine(lineName: string, citycode: string) {
  const result = await amapRequest<BusLineResponse>(
    '/v3/bus/linename',
    new URLSearchParams({
      keywords: lineName.split('(')[0].trim(),
      city: citycode,
      extensions: 'all',
      offset: '20',
      page: '1',
    }),
  );

  const normalizedRequestedName = normalizeLineName(lineName);
  return (result.buslines ?? []).filter(
    (line) =>
      line.id &&
      line.name &&
      normalizeLineName(line.name) === normalizedRequestedName &&
      Array.isArray(line.busstops),
  );
}

function collectLineCandidates(
  lines: AMapBusLine[],
  accessStations: AccessStationWithWalk[],
  anchorLocation: string,
) {
  const candidates = new Map<string, CandidateStation>();
  for (const line of lines) {
    const displayLineName = line.name?.split('(')[0].trim() ?? '';
    for (const stop of line.busstops ?? []) {
      if (
        !stop.id ||
        !stop.name ||
        !stop.location ||
        !locationPattern.test(stop.location) ||
        accessStations.some(
          (accessStation) =>
            straightLineDistance(accessStation.location, stop.location!) < 250,
        )
      ) {
        continue;
      }

      const logicalId = stop.id;
      const existing = candidates.get(logicalId);
      if (existing) {
        if (displayLineName && !existing.lines.includes(displayLineName)) {
          existing.lines.push(displayLineName);
        }
        continue;
      }
      candidates.set(logicalId, {
        id: stop.id,
        logicalId,
        name: stop.name,
        location: stop.location,
        mode: lineMode(line),
        address: displayLineName,
        lines: displayLineName ? [displayLineName] : [],
        citycode: line.citycode ?? accessStations[0]?.citycode ?? '',
        adcode: '',
      });
    }
  }

  return [...candidates.values()].sort(
    (left, right) =>
      straightLineDistance(anchorLocation, right.location) -
      straightLineDistance(anchorLocation, left.location),
  );
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
      { retries: 1, timeoutMilliseconds: 8_000 },
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
  routeGeometry: RouteGeometrySegment[];
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
    show_fields: 'cost,polyline',
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
          routeGeometry: collectRouteGeometry(route.segments),
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
    routeGeometry: route.routeGeometry,
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
  const farthest = reachable[0] ?? null;

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
    farthest,
    nearMisses: nearMisses.map((station) => ({
      ...station,
      routeGeometry: [],
    })),
    stations: reachable
      .slice(0, 12)
      .map((station) =>
        station.logicalId === farthest?.logicalId
          ? station
          : { ...station, routeGeometry: [] },
      ),
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
      !Array.isArray(station.availableLines) ||
      station.availableLines.length > 30 ||
      station.availableLines.some(
        (line) =>
          typeof line !== 'string' || line.length < 1 || line.length > 80,
      ) ||
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
      availableLines: [
        ...new Set(station.availableLines!.map((line) => line.trim())),
      ],
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
          `${station.id}:${station.availableLines.slice().sort().join(',')}:${station.allowedLines.slice().sort().join(',')}`,
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
    const lineSeedMap = new Map<string, { name: string; citycode: string }>();
    for (const station of activeAccessStations) {
      const lineNames =
        station.allowedLines.length > 0
          ? station.allowedLines
          : station.availableLines;
      for (const lineName of lineNames) {
        const key = `${station.citycode}:${normalizeLineName(lineName)}`;
        if (!lineSeedMap.has(key)) {
          lineSeedMap.set(key, { name: lineName, citycode: station.citycode });
        }
      }
    }
    const lineSeeds = [...lineSeedMap.values()].slice(0, 8);
    if (lineSeeds.length === 0) {
      return Response.json(
        {
          error: {
            code: 'NO_TRANSIT_LINES',
            message: '所选接驳站点没有可用于扩展的线路信息。',
          },
        },
        { status: 422 },
      );
    }
    const expandedLineGroups = await runThrottled(
      lineSeeds,
      250,
      async (seed) => {
        try {
          return await expandTransitLine(seed.name, seed.citycode);
        } catch {
          return [];
        }
      },
    );
    const expandedLineMap = new Map<string, AMapBusLine>();
    for (const line of expandedLineGroups.flat()) {
      if (line.id && !expandedLineMap.has(line.id)) {
        expandedLineMap.set(line.id, line);
      }
    }
    const expandedLines = [...expandedLineMap.values()];
    const allCandidates = collectLineCandidates(
      expandedLines,
      activeAccessStations,
      validatedAnchor.location,
    );
    if (allCandidates.length === 0) {
      return Response.json(
        {
          error: {
            code: 'NO_LINE_CANDIDATES',
            message: '没有从所选线路中取得可计算的沿线站点。',
          },
        },
        { status: 422 },
      );
    }
    const candidateLimit = Math.max(
      4,
      Math.floor(12 / activeAccessStations.length),
    );
    const candidates = selectEvenly(allCandidates, candidateLimit);
    const networkSpanMeters = Math.max(
      ...allCandidates.map((station) =>
        straightLineDistance(validatedAnchor.location, station.location),
      ),
    );

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
      candidateSource: 'transit_lines',
      budgetMinutes,
      networkSpanMeters,
      candidateCount: candidates.length,
      lineQueryCount: lineSeeds.length,
      expandedLineCount: expandedLines.length,
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
