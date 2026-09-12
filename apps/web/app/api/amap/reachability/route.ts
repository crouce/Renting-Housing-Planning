import { amapErrorResponse, amapRequest } from '@/lib/amap-server';

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
          buslines?: Array<{
            id?: string;
            name?: string;
            type?: string;
            polyline?: unknown;
            departure_stop?: AMapTransitStop;
            via_stops?: AMapTransitStop[];
            arrival_stop?: AMapTransitStop;
          }>;
        };
      }>;
    }>;
  };
};

type AMapTransitStop = {
  id?: string;
  name?: string;
  location?: string;
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

type AccessLineSeed = {
  accessStation: AccessStationWithWalk;
  lineName: string;
  citycode: string;
};

type LineDirectionContext = {
  id: string;
  accessStation: AccessStationWithWalk;
  requestedLineName: string;
  line: AMapBusLine;
  directionLabel: string;
  candidates: CandidateStation[];
};

type RouteGeometrySegment = {
  mode: 'WALK' | 'TRANSIT';
  path: Array<[number, number]>;
  lineId?: string;
  lineName?: string;
  transitMode?: TransitMode;
  stops: Array<{
    id: string;
    name: string;
    location: [number, number];
    role: 'BOARD' | 'VIA' | 'ALIGHT';
  }>;
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
  lineDirection: {
    id: string;
    lineName: string;
    directionLabel: string;
    startStopName: string;
    endStopName: string;
  };
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
  direction: 'to';
  routeCheckCount: number;
  checkedCount: number;
  failedCount: number;
  reachableCount: number;
  fastestCandidateMinutes: number | null;
  farthest: ReachableStation | null;
  nearMisses: ReachableStation[];
  stations: ReachableStation[];
  accessRoutes: Array<{
    accessStationId: string;
    accessStationName: string;
    reachableCount: number;
    farthestRouteId: string | null;
    routeIds: string[];
    directions: Array<{
      id: string;
      lineName: string;
      directionLabel: string;
      startStopName: string;
      endStopName: string;
      candidateCount: number;
      routeCheckCount: number;
      status: 'reachable' | 'over_budget' | 'no_route' | 'no_candidate';
      farthestRouteId: string | null;
    }>;
  }>;
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
    .replaceAll(/地铁|轨道交通|轨交/g, '')
    .replaceAll(/\s/g, '')
    .toLowerCase();
}

function lineMode(line: AMapBusLine): TransitMode {
  return transitMode(`${line.type ?? ''} ${line.name ?? ''}`);
}

function transitMode(description: string): TransitMode {
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
      if (path.length > 1) geometry.push({ mode: 'WALK', path, stops: [] });
    }
    for (const busline of segment.bus?.buslines ?? []) {
      const path = parsePolyline(busline.polyline);
      if (path.length < 2) continue;
      const stops = [
        { stop: busline.departure_stop, role: 'BOARD' as const },
        ...(busline.via_stops ?? []).map((stop) => ({
          stop,
          role: 'VIA' as const,
        })),
        { stop: busline.arrival_stop, role: 'ALIGHT' as const },
      ].flatMap(({ stop, role }) => {
        if (
          !stop?.name ||
          !stop.location ||
          !locationPattern.test(stop.location)
        ) {
          return [];
        }
        return [
          {
            id: stop.id ?? `${stop.name}:${stop.location}`,
            name: stop.name,
            location: parseLocation(stop.location),
            role,
          },
        ];
      });
      geometry.push({
        mode: 'TRANSIT',
        path,
        lineId: busline.id,
        lineName: busline.name?.trim(),
        transitMode: transitMode(`${busline.type ?? ''} ${busline.name ?? ''}`),
        stops,
      });
    }
  }
  return geometry;
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

function nearestLineStopIndex(
  line: AMapBusLine,
  accessStation: AccessStationWithWalk,
) {
  const stops = line.busstops ?? [];
  const exactIndex = stops.findIndex((stop) => stop.id === accessStation.id);
  if (exactIndex >= 0) return exactIndex;

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, stop] of stops.entries()) {
    if (!stop.location || !locationPattern.test(stop.location)) continue;
    const distance = straightLineDistance(
      accessStation.location,
      stop.location,
    );
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestDistance <= 600 ? nearestIndex : -1;
}

function createLineDirectionContext(
  seed: AccessLineSeed,
  line: AMapBusLine,
): LineDirectionContext | null {
  if (!line.id) return null;
  const accessStopIndex = nearestLineStopIndex(line, seed.accessStation);
  if (accessStopIndex < 0) return null;

  const displayLineName =
    line.name?.split('(')[0].trim() || seed.lineName.split('(')[0].trim();
  const directionLabel = line.end_stop
    ? `开往 ${line.end_stop}`
    : `${line.start_stop ?? '起点'} → ${line.end_stop ?? '终点'}`;
  const id = `${seed.accessStation.id}::${line.id}`;
  const candidates = (line.busstops ?? [])
    .slice(0, accessStopIndex)
    .flatMap((stop) => {
      if (
        !stop.id ||
        !stop.name ||
        !stop.location ||
        !locationPattern.test(stop.location) ||
        straightLineDistance(seed.accessStation.location, stop.location) < 250
      ) {
        return [];
      }
      return [
        {
          id: stop.id,
          logicalId: `${id}::${stop.id}`,
          name: stop.name,
          location: stop.location,
          mode: lineMode(line),
          address: directionLabel,
          lines: displayLineName ? [displayLineName] : [],
          citycode: line.citycode ?? seed.citycode,
          adcode: '',
        } satisfies CandidateStation,
      ];
    })
    .reverse();

  return {
    id,
    accessStation: seed.accessStation,
    requestedLineName: seed.lineName,
    line,
    directionLabel,
    candidates,
  };
}

function selectLineSeedsFairly(
  accessStations: AccessStationWithWalk[],
  limit: number,
) {
  const queues = accessStations.map((accessStation) => ({
    accessStation,
    lineNames:
      accessStation.allowedLines.length > 0
        ? accessStation.allowedLines
        : accessStation.availableLines,
  }));
  const seeds: AccessLineSeed[] = [];
  for (let lineIndex = 0; seeds.length < limit; lineIndex += 1) {
    let added = false;
    for (const queue of queues) {
      const lineName = queue.lineNames[lineIndex];
      if (!lineName || seeds.length >= limit) continue;
      seeds.push({
        accessStation: queue.accessStation,
        lineName,
        citycode: queue.accessStation.citycode,
      });
      added = true;
    }
    if (!added) break;
  }
  return seeds;
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

  const params = new URLSearchParams({
    origin: station.location,
    destination: accessStation.location,
    city1: station.citycode,
    city2: accessStation.citycode,
    originpoi: station.id,
    destinationpoi: accessStation.id,
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
  contexts: LineDirectionContext[],
  activeAccessStations: AccessStationWithWalk[],
  departureDate: string,
  departureTime: string,
  anchorLocation: string,
): Promise<DirectionReachability> {
  const maxChecksPerDirection =
    contexts.length <= 6 ? 4 : contexts.length <= 12 ? 3 : 2;
  const evaluations: Array<{
    context: LineDirectionContext;
    routeCheckCount: number;
    failedCount: number;
    successful: ReachableStation[];
    best: ReachableStation | null;
  }> = [];

  for (const context of contexts) {
    let routeCheckCount = 0;
    let failedCount = 0;
    const successful: ReachableStation[] = [];
    let best: ReachableStation | null = null;
    const restrictedAccessStation = {
      ...context.accessStation,
      allowedLines: [context.requestedLineName],
    };
    const evaluateCandidate = async (candidateIndex: number) => {
      const station = context.candidates[candidateIndex];
      routeCheckCount += 1;
      const route = await planTransit(
        station,
        restrictedAccessStation,
        departureDate,
        departureTime,
      );
      if (!route) {
        failedCount += 1;
        return null;
      }
      const evaluated: ReachableStation = {
        ...station,
        logicalId: `${station.logicalId}::result`,
        transitDurationSeconds: route.transitDurationSeconds,
        transitDurationMinutes: Math.ceil(route.transitDurationSeconds / 60),
        durationSeconds: route.durationSeconds,
        durationMinutes: Math.ceil(route.durationSeconds / 60),
        straightLineMeters: straightLineDistance(
          anchorLocation,
          station.location,
        ),
        segmentCount: route.segmentCount,
        routeLines: route.routeLines,
        matchedLines: route.matchedLines,
        routeGeometry: route.routeGeometry,
        lineDirection: {
          id: context.id,
          lineName: context.requestedLineName,
          directionLabel: context.directionLabel,
          startStopName: context.line.start_stop ?? '',
          endStopName: context.line.end_stop ?? '',
        },
        accessStation: route.accessStation,
      };
      successful.push(evaluated);
      return evaluated;
    };

    if (context.candidates.length > 0) {
      let low = 0;
      let high = context.candidates.length - 1;
      const endpoint = await evaluateCandidate(high);
      if (
        endpoint &&
        endpoint.transitDurationSeconds <=
          endpoint.accessStation.remainingTransitSeconds
      ) {
        best = endpoint;
      } else {
        high -= 1;
        while (low <= high && routeCheckCount < maxChecksPerDirection) {
          const middle = Math.ceil((low + high) / 2);
          const evaluated = await evaluateCandidate(middle);
          if (
            evaluated &&
            evaluated.transitDurationSeconds <=
              evaluated.accessStation.remainingTransitSeconds
          ) {
            best = evaluated;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
          if (routeCheckCount < maxChecksPerDirection) {
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        }
      }
    }
    evaluations.push({
      context,
      routeCheckCount,
      failedCount,
      successful,
      best,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const reachable = evaluations
    .flatMap((evaluation) => (evaluation.best ? [evaluation.best] : []))
    .sort((left, right) => right.straightLineMeters - left.straightLineMeters);
  const allSuccessful = evaluations.flatMap(
    (evaluation) => evaluation.successful,
  );
  const nearMisses = allSuccessful
    .filter(
      (station) =>
        station.transitDurationSeconds >
        station.accessStation.remainingTransitSeconds,
    )
    .sort((left, right) => left.durationSeconds - right.durationSeconds)
    .slice(0, 3);
  const farthest = reachable[0] ?? null;
  const accessRoutes = activeAccessStations.map((accessStation) => {
    const routes = reachable.filter(
      (station) => station.accessStation.id === accessStation.id,
    );
    const directionEvaluations = evaluations.filter(
      (evaluation) => evaluation.context.accessStation.id === accessStation.id,
    );
    return {
      accessStationId: accessStation.id,
      accessStationName: accessStation.name,
      reachableCount: routes.length,
      farthestRouteId: routes[0]?.logicalId ?? null,
      routeIds: routes.map((station) => station.logicalId),
      directions: directionEvaluations.map((evaluation) => ({
        id: evaluation.context.id,
        lineName: evaluation.context.requestedLineName,
        directionLabel: evaluation.context.directionLabel,
        startStopName: evaluation.context.line.start_stop ?? '',
        endStopName: evaluation.context.line.end_stop ?? '',
        candidateCount: evaluation.context.candidates.length,
        routeCheckCount: evaluation.routeCheckCount,
        status: evaluation.best
          ? ('reachable' as const)
          : evaluation.context.candidates.length === 0
            ? ('no_candidate' as const)
            : evaluation.successful.length > 0
              ? ('over_budget' as const)
              : ('no_route' as const),
        farthestRouteId: evaluation.best?.logicalId ?? null,
      })),
    };
  });

  return {
    direction: 'to',
    routeCheckCount: evaluations.reduce(
      (sum, evaluation) => sum + evaluation.routeCheckCount,
      0,
    ),
    checkedCount: allSuccessful.length,
    failedCount: evaluations.reduce(
      (sum, evaluation) => sum + evaluation.failedCount,
      0,
    ),
    reachableCount: reachable.length,
    fastestCandidateMinutes:
      allSuccessful.length > 0
        ? Math.ceil(
            Math.min(
              ...allSuccessful.map((station) => station.durationSeconds),
            ) / 60,
          )
        : null,
    farthest,
    nearMisses: nearMisses.map((station) => ({
      ...station,
      routeGeometry: [],
    })),
    stations: reachable,
    accessRoutes,
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
    'station-line-direction-v2',
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
    const lineSeeds = selectLineSeedsFairly(activeAccessStations, 8);
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
          return {
            seed,
            lines: await expandTransitLine(seed.lineName, seed.citycode),
          };
        } catch {
          return { seed, lines: [] };
        }
      },
    );
    const contexts = expandedLineGroups.flatMap(({ seed, lines }) => {
      const seenDirections = new Set<string>();
      const resolvedDirections = lines.flatMap((line) => {
        const directionKey = `${line.start_stop ?? ''}::${line.end_stop ?? ''}`;
        if (seenDirections.has(directionKey)) return [];
        const context = createLineDirectionContext(seed, line);
        if (!context) return [];
        seenDirections.add(directionKey);
        return [context];
      });
      return resolvedDirections.slice(0, 2);
    });
    const allCandidates = contexts.flatMap((context) => context.candidates);
    if (contexts.length === 0) {
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
    const networkSpanMeters =
      allCandidates.length > 0
        ? Math.max(
            ...allCandidates.map((station) =>
              straightLineDistance(validatedAnchor.location, station.location),
            ),
          )
        : 0;

    const to = await evaluateDirection(
      contexts,
      activeAccessStations,
      departureDate,
      departureTime,
      validatedAnchor.location,
    );
    const result: ReachabilityResult = {
      sampled: true,
      candidateSource: 'transit_lines',
      budgetMinutes,
      networkSpanMeters,
      candidateCount: allCandidates.length,
      lineQueryCount: lineSeeds.length,
      expandedLineCount: contexts.length,
      routeCheckCount: to.routeCheckCount,
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
      directions: { to },
    };

    cache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: result });
    return Response.json(result);
  } catch (error) {
    return amapErrorResponse(error);
  }
}
