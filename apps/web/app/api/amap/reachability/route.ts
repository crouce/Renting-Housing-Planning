import {
  AMapServerError,
  amapErrorResponse,
  amapRequest,
} from '@/lib/amap-server';
import {
  BoundedCache,
  matchesDirectLine,
  normalizeLineName,
  searchDirection,
  type Observation,
} from '@/lib/reachability-core';
import type {
  CalculationIssue,
  DirectionSummary,
} from '@/lib/reachability-types';

type TransitMode = 'BUS' | 'SUBWAY' | 'LIGHT_RAIL';

type ReachabilityRequest = {
  refresh?: boolean;
  retryDirectionId?: string;
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
        railway?: unknown;
        taxi?: unknown;
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
  stopIndex: number;
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
  accessStopIndex: number;
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
  walkingDurationSeconds: number;
  remainingTransitMinutes: number;
  remainingTransitSeconds: number;
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
    directions: DirectionSummary[];
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
  partial: boolean;
  issues: CalculationIssue[];
  cachedDirectionCount: number;
  accessStationBudgets: AccessStationBudget[];
  directions: {
    to: DirectionReachability;
  };
};

const locationPattern = /^-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const walkingCache = new BoundedCache<AccessStationWithWalk>(64, 256_000);
const lineCache = new BoundedCache<AMapBusLine[]>(48, 2 * 1024 * 1024);
type DirectionEvaluation = {
  context: LineDirectionContext;
  observations: Observation<ReachableStation>[];
  best: ReachableStation | null;
  summary: DirectionSummary;
};
const directionCache = new BoundedCache<Omit<DirectionEvaluation, 'context'>>(
  48,
);
const pendingDirections = new Map<
  string,
  Promise<Omit<DirectionEvaluation, 'context'>>
>();
let nextRequestAt = 0;
async function paceRequest() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + 350;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}

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

function lineMode(line: AMapBusLine): TransitMode {
  return transitMode(`${line.type ?? ''} ${line.name ?? ''}`);
}

function transitMode(description: string): TransitMode {
  if (/有轨电车|轻轨/.test(description)) return 'LIGHT_RAIL';
  if (/地铁|轨道交通/.test(description)) return 'SUBWAY';
  return 'BUS';
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

async function expandTransitLine(
  lineName: string,
  citycode: string,
  refresh = false,
) {
  const key = `${citycode}:${normalizeLineName(lineName)}`;
  const cached = refresh ? undefined : lineCache.get(key);
  if (cached) return cached;
  await paceRequest();
  const result = await amapRequest<BusLineResponse>(
    '/v3/bus/linename',
    new URLSearchParams({
      keywords: lineName.split(/[（(]/)[0].trim(),
      city: citycode,
      extensions: 'all',
      offset: '20',
      page: '1',
    }),
  );

  const normalizedRequestedName = normalizeLineName(lineName);
  const lines = (result.buslines ?? []).filter(
    (line) =>
      line.id &&
      line.name &&
      normalizeLineName(line.name) === normalizedRequestedName &&
      Array.isArray(line.busstops),
  );
  if (lines.length) lineCache.set(key, lines, 24 * 60 * 60_000);
  return lines;
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
    .flatMap((stop, stopIndex) => {
      if (
        !stop.id ||
        !stop.name ||
        !stop.location ||
        !locationPattern.test(stop.location)
      ) {
        return [];
      }
      return [
        {
          stopIndex,
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
    accessStopIndex,
    directionLabel,
    candidates,
  };
}

function selectLineSeeds(accessStations: AccessStationWithWalk[]) {
  return accessStations.flatMap((accessStation) => {
    const names = accessStation.allowedLines.length
      ? accessStation.allowedLines
      : accessStation.availableLines;
    const unique = new Map(
      names.map((name) => [normalizeLineName(name), name]),
    );
    return [...unique.values()].sort().map((lineName) => ({
      accessStation,
      lineName,
      citycode: accessStation.citycode,
    }));
  });
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
  refresh = false,
): Promise<AccessStationWithWalk> {
  const key = JSON.stringify([
    anchor.id,
    anchor.location,
    accessStation.id,
    accessStation.location,
  ]);
  const cached = refresh ? undefined : walkingCache.get(key);
  if (cached)
    return {
      ...cached,
      ...accessStation,
      remainingTransitSeconds: Math.max(
        0,
        budgetSeconds - cached.walkingDurationSeconds,
      ),
    };
  const params = new URLSearchParams({
    origin: anchor.location!,
    destination: accessStation.location,
    origin_id: anchor.id!,
    destination_id: accessStation.id,
    alternative_route: '1',
    show_fields: 'cost',
  });

  await paceRequest();
  {
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
    if (!best)
      throw new AMapServerError(
        '未取得接驳步行路线。',
        'NO_WALKING_ROUTE',
        422,
      );

    const plan = {
      ...accessStation,
      walkingDistanceMeters: Math.round(best.distanceMeters),
      walkingDurationSeconds: Math.ceil(best.durationSeconds),
      remainingTransitSeconds: Math.max(
        0,
        budgetSeconds - Math.ceil(best.durationSeconds),
      ),
    };
    walkingCache.set(key, plan, 10 * 60_000);
    return plan;
  }
}

async function checkTransit(
  station: CandidateStation,
  context: LineDirectionContext,
  departureDate: string,
  departureTime: string,
  anchorLocation: string,
): Promise<Omit<Observation<ReachableStation>, 'index'>> {
  const accessStation = context.accessStation;
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
    await paceRequest();
    const result = await amapRequest<TransitResponse>(
      '/v5/direction/transit/integrated',
      params,
      { retries: 0, timeoutMilliseconds: 8_000 },
    );
    const routes = (result.route?.transits ?? [])
      .flatMap((route) => {
        const segments = route.segments ?? [];
        const busSegments = segments.filter(
          (segment) => (segment.bus?.buslines?.length ?? 0) > 0,
        );
        // A line direction denotes one direct ride; transfers are a different product.
        if (
          busSegments.length !== 1 ||
          segments.some((segment) =>
            [segment.railway, segment.taxi].some(
              (value) =>
                value &&
                typeof value === 'object' &&
                Object.keys(value).length > 0,
            ),
          )
        )
          return [];
        const busline = busSegments[0].bus!.buslines!.find((line) =>
          matchesDirectLine(line, {
            id: context.line.id!,
            name: context.line.name!,
            stops: context.line.busstops ?? [],
            boardIndex: station.stopIndex,
            alightIndex: context.accessStopIndex,
          }),
        );
        if (!busline) return [];
        const seconds = Number(route.cost?.duration);
        if (!Number.isFinite(seconds) || seconds <= 0) return [];
        const chosenSegments = segments.map((segment) =>
          segment === busSegments[0]
            ? { ...segment, bus: { buslines: [busline] } }
            : segment,
        );
        const reachable = seconds <= accessStation.remainingTransitSeconds;
        const planned: ReachableStation = {
          ...station,
          transitDurationSeconds: seconds,
          transitDurationMinutes: Math.ceil(seconds / 60),
          durationSeconds: seconds + accessStation.walkingDurationSeconds,
          durationMinutes: Math.ceil(
            (seconds + accessStation.walkingDurationSeconds) / 60,
          ),
          straightLineMeters: straightLineDistance(
            anchorLocation,
            station.location,
          ),
          segmentCount: 1,
          routeLines: [busline.name!],
          matchedLines: [context.requestedLineName],
          routeGeometry: reachable ? collectRouteGeometry(chosenSegments) : [],
          lineDirection: {
            id: context.id,
            lineName: context.requestedLineName,
            directionLabel: context.directionLabel,
            startStopName: context.line.start_stop ?? '',
            endStopName: context.line.end_stop ?? '',
          },
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
        return [planned];
      })
      .sort((a, b) => a.transitDurationSeconds - b.transitDurationSeconds);
    const route = routes[0];
    if (!route)
      return { status: 'no_route', errorCode: 'NO_MATCHING_DIRECT_ROUTE' };
    return {
      status:
        route.transitDurationSeconds <= accessStation.remainingTransitSeconds
          ? 'reachable'
          : 'over_budget',
      durationSeconds: route.transitDurationSeconds,
      route:
        route.transitDurationSeconds <= accessStation.remainingTransitSeconds
          ? route
          : undefined,
    };
  } catch (error) {
    return {
      status: 'error',
      errorCode:
        error instanceof AMapServerError
          ? error.code
          : 'AMAP_UPSTREAM_UNAVAILABLE',
    };
  }
}

async function evaluateLineDirection(
  context: LineDirectionContext,
  departureDate: string,
  departureTime: string,
  anchorLocation: string,
  refresh: boolean,
  resume: boolean,
): Promise<DirectionEvaluation> {
  const key = JSON.stringify([
    'verified-directions-v1',
    anchorLocation,
    context.id,
    context.requestedLineName,
    context.accessStation.location,
    context.accessStation.citycode,
    context.accessStation.walkingDurationSeconds,
    context.accessStation.remainingTransitSeconds,
    departureDate,
    departureTime,
    context.accessStopIndex,
    context.line.name,
    context.line.busstops,
  ]);
  const cached = refresh ? undefined : directionCache.get(key);
  if (cached && !resume)
    return {
      ...cached,
      context,
      summary: { ...cached.summary, cached: true, routeCheckCount: 0 },
    };
  const pending = pendingDirections.get(key);
  if (pending) {
    const value = await pending;
    return {
      ...value,
      context,
      summary: { ...value.summary, cached: true, routeCheckCount: 0 },
    };
  }
  const calculate = async (): Promise<Omit<DirectionEvaluation, 'context'>> => {
    const searched = await searchDirection<ReachableStation>({
      count: context.candidates.length,
      previous: cached?.observations,
      check: (index) =>
        checkTransit(
          context.candidates[index],
          context,
          departureDate,
          departureTime,
          anchorLocation,
        ),
    });
    const best = searched.best?.route ?? null;
    // Retain only the best route's geometry; all other checkpoints need just timing/status.
    const observations = searched.observations.map((item) => ({
      ...item,
      route: item.index === searched.best?.index ? item.route : undefined,
    }));
    const relevant = observations.filter((item) =>
      searched.unresolved.includes(item.index),
    );
    const summary: DirectionSummary = {
      id: context.id,
      lineName: context.requestedLineName,
      directionLabel: context.directionLabel,
      startStopName: context.line.start_stop ?? '',
      endStopName: context.line.end_stop ?? '',
      candidateCount: context.candidates.length,
      routeCheckCount: searched.calls,
      checkedCount: observations.filter(
        (item) => item.status === 'reachable' || item.status === 'over_budget',
      ).length,
      status: searched.status,
      boundaryConfirmed: searched.confirmed,
      pendingCount: searched.unresolved.length,
      errorCount: relevant.filter((item) => item.status === 'error').length,
      noRouteCount: relevant.filter((item) => item.status === 'no_route')
        .length,
      cached: false,
      farthestRouteId: best?.logicalId ?? null,
      evidence: context.candidates.map((candidate, index) => {
        const checked = observations.find((item) => item.index === index);
        return {
          stationName: candidate.name,
          status: checked?.status ?? 'unverified',
          durationMinutes:
            checked?.durationSeconds === undefined
              ? undefined
              : Math.ceil(checked.durationSeconds / 60),
          durationSeconds: checked?.durationSeconds,
          errorCode: checked?.errorCode,
        };
      }),
    };
    const value = { observations, best, summary };
    directionCache.set(key, value, 10 * 60_000);
    return value;
  };
  const task = calculate();
  pendingDirections.set(key, task);
  try {
    return { ...(await task), context };
  } finally {
    pendingDirections.delete(key);
  }
}

async function evaluateDirection(
  contexts: LineDirectionContext[],
  activeAccessStations: AccessStationWithWalk[],
  departureDate: string,
  departureTime: string,
  anchorLocation: string,
  refresh: boolean,
  resume: boolean,
  signal: AbortSignal,
): Promise<DirectionReachability> {
  const evaluations: DirectionEvaluation[] = [];
  for (const context of contexts) {
    signal.throwIfAborted();
    evaluations.push(
      await evaluateLineDirection(
        context,
        departureDate,
        departureTime,
        anchorLocation,
        refresh,
        resume,
      ),
    );
  }
  const reachable = evaluations
    .flatMap((item) => (item.best ? [item.best] : []))
    .sort((a, b) => b.straightLineMeters - a.straightLineMeters);
  return {
    direction: 'to',
    routeCheckCount: evaluations.reduce(
      (sum, item) => sum + item.summary.routeCheckCount,
      0,
    ),
    checkedCount: evaluations.reduce(
      (sum, item) => sum + item.summary.checkedCount,
      0,
    ),
    failedCount: evaluations.reduce(
      (sum, item) => sum + item.summary.errorCount,
      0,
    ),
    reachableCount: reachable.length,
    fastestCandidateMinutes: reachable.length
      ? Math.min(...reachable.map((item) => item.durationMinutes))
      : null,
    farthest: reachable[0] ?? null,
    nearMisses: [],
    stations: reachable,
    accessRoutes: activeAccessStations.map((accessStation) => {
      const own = evaluations.filter(
        (item) => item.context.accessStation.id === accessStation.id,
      );
      const routes = reachable.filter(
        (item) => item.accessStation.id === accessStation.id,
      );
      return {
        accessStationId: accessStation.id,
        accessStationName: accessStation.name,
        reachableCount: routes.length,
        farthestRouteId: routes[0]?.logicalId ?? null,
        routeIds: routes.map((item) => item.logicalId),
        directions: own.map((item) => item.summary),
      };
    }),
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
  const selectedLineCount = accessStations.reduce(
    (count, station) =>
      count +
      new Set(
        (station.allowedLines.length
          ? station.allowedLines
          : station.availableLines
        ).map(normalizeLineName),
      ).size,
    0,
  );
  if (selectedLineCount > 8)
    return Response.json(
      {
        error: {
          code: 'TOO_MANY_LINES',
          message: `本次选择了 ${selectedLineCount} 条站点线路，请限定到 8 条以内后计算。每条线路都会完整保留其运行方向。`,
        },
      },
      { status: 400 },
    );
  const refresh = body.refresh === true;
  const retryDirectionId = body.retryDirectionId;
  if (
    (retryDirectionId !== undefined &&
      (typeof retryDirectionId !== 'string' ||
        retryDirectionId.length > 240)) ||
    (body.refresh !== undefined && typeof body.refresh !== 'boolean')
  ) {
    return Response.json(
      { error: { message: '重试参数不正确。' } },
      { status: 400 },
    );
  }

  try {
    const issues: CalculationIssue[] = [];
    const walkingPlans = await runThrottled(
      accessStations,
      0,
      async (station) => {
        request.signal.throwIfAborted();
        try {
          return await planWalking(
            validatedAnchor,
            station,
            budgetMinutes * 60,
            refresh,
          );
        } catch {
          issues.push({
            id: `walk:${station.id}`,
            accessStationId: station.id,
            accessStationName: station.name,
            message: '步行路线未取得，请重试该接驳站。',
          });
          return null;
        }
      },
    );
    const plannedAccessStations = walkingPlans.filter(
      (station): station is AccessStationWithWalk => Boolean(station),
    );
    const activeAccessStations = plannedAccessStations.filter(
      (station) => station.remainingTransitSeconds > 0,
    );
    for (const station of activeAccessStations) {
      if (!station.availableLines.length && !station.allowedLines.length)
        issues.push({
          id: `line:${station.id}`,
          accessStationId: station.id,
          accessStationName: station.name,
          message: '本站还没有线路信息，请更新附近站点后再试。',
        });
    }
    const lineSeeds = selectLineSeeds(activeAccessStations);
    const queries = new Map<string, Promise<AMapBusLine[]>>();
    const contexts: LineDirectionContext[] = [];
    for (const seed of lineSeeds) {
      request.signal.throwIfAborted();
      const queryKey = `${seed.citycode}:${normalizeLineName(seed.lineName)}`;
      if (!queries.has(queryKey))
        queries.set(
          queryKey,
          expandTransitLine(seed.lineName, seed.citycode, refresh),
        );
      try {
        const lines = await queries.get(queryKey)!;
        const seen = new Set<string>();
        const resolved = lines.flatMap((line) => {
          const context = createLineDirectionContext(seed, line);
          if (!context || seen.has(context.id)) return [];
          seen.add(context.id);
          return [context];
        });
        if (resolved.length === 0)
          issues.push({
            id: `line:${seed.accessStation.id}:${normalizeLineName(seed.lineName)}`,
            accessStationId: seed.accessStation.id,
            accessStationName: seed.accessStation.name,
            lineName: seed.lineName,
            message: '未匹配到本站的线路站序，方向待确认。',
          });
        contexts.push(...resolved);
      } catch {
        issues.push({
          id: `line:${seed.accessStation.id}:${normalizeLineName(seed.lineName)}`,
          accessStationId: seed.accessStation.id,
          accessStationName: seed.accessStation.name,
          lineName: seed.lineName,
          message: '线路查询失败，方向待确认。',
        });
      }
    }
    const selectedContexts = retryDirectionId
      ? contexts.filter((context) => context.id === retryDirectionId)
      : contexts;
    if (retryDirectionId && selectedContexts.length === 0) {
      return Response.json(
        {
          error: {
            code: 'DIRECTION_UNAVAILABLE',
            message: '暂时无法重新取得这个方向，已保留原结果，请稍后重试。',
          },
        },
        { status: 422 },
      );
    }
    const allCandidates = selectedContexts.flatMap(
      (context) => context.candidates,
    );
    const to = await evaluateDirection(
      selectedContexts,
      activeAccessStations,
      departureDate,
      departureTime,
      validatedAnchor.location,
      refresh,
      Boolean(retryDirectionId),
      request.signal,
    );
    const result: ReachabilityResult = {
      sampled: true,
      candidateSource: 'transit_lines',
      budgetMinutes,
      networkSpanMeters: Math.max(
        0,
        ...allCandidates.map((station) =>
          straightLineDistance(validatedAnchor.location, station.location),
        ),
      ),
      candidateCount: allCandidates.length,
      lineQueryCount: queries.size,
      expandedLineCount: selectedContexts.length,
      routeCheckCount: to.routeCheckCount,
      selectedAccessStationCount: accessStations.length,
      partial: Boolean(retryDirectionId),
      issues,
      cachedDirectionCount: to.accessRoutes
        .flatMap((group) => group.directions)
        .filter((direction) => direction.cached).length,
      accessStationBudgets: plannedAccessStations.map((station) => ({
        id: station.id,
        name: station.name,
        walkingDistanceMeters: station.walkingDistanceMeters,
        walkingMinutes: Math.ceil(station.walkingDurationSeconds / 60),
        walkingDurationSeconds: station.walkingDurationSeconds,
        remainingTransitSeconds: station.remainingTransitSeconds,
        remainingTransitMinutes: Math.floor(
          station.remainingTransitSeconds / 60,
        ),
        usable: station.remainingTransitSeconds > 0,
      })),
      directions: { to },
    };
    return Response.json(result);
  } catch (error) {
    return amapErrorResponse(error);
  }
}
