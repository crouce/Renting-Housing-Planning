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
  direction?: CommuteDirection;
  departureDate?: string;
  departureTime?: string;
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
      segments?: unknown[];
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
  durationSeconds: number;
  durationMinutes: number;
  straightLineMeters: number;
  segmentCount: number;
};

type ReachabilityResult = {
  sampled: true;
  budgetMinutes: number;
  scanRadiusMeters: number;
  candidateCount: number;
  checkedCount: number;
  failedCount: number;
  reachableCount: number;
  fastestCandidateMinutes: number | null;
  farthest: ReachableStation | null;
  nearMisses: ReachableStation[];
  stations: ReachableStation[];
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
  const rail = stations.filter((station) => station.mode !== 'BUS');
  return (rail[0] ?? stations[0]) ? [rail[0] ?? stations[0]] : [];
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

async function planTransit(
  station: CandidateStation,
  anchor: NonNullable<ReachabilityRequest['anchor']> & {
    id: string;
    name: string;
    location: string;
  },
  anchorCitycode: string,
  direction: CommuteDirection,
  departureDate: string,
  departureTime: string,
): Promise<{ durationSeconds: number; segmentCount: number } | null> {
  if (!station.citycode || !anchorCitycode) return null;

  const toAnchor = direction === 'to';
  const params = new URLSearchParams({
    origin: toAnchor ? station.location : anchor.location,
    destination: toAnchor ? anchor.location : station.location,
    city1: toAnchor ? station.citycode : anchorCitycode,
    city2: toAnchor ? anchorCitycode : station.citycode,
    originpoi: toAnchor ? station.id : anchor.id,
    destinationpoi: toAnchor ? anchor.id : station.id,
    strategy: '8',
    AlternativeRoute: '1',
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
      .map((route) => ({
        durationSeconds: Number(route.cost?.duration ?? 0),
        segmentCount: route.segments?.length ?? 0,
      }))
      .filter((route) => route.durationSeconds > 0)
      .sort((left, right) => left.durationSeconds - right.durationSeconds);

    return routes[0] ?? null;
  } catch {
    return null;
  }
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
  const direction = body.direction;
  const departureDate = body.departureDate ?? '';
  const departureTime = body.departureTime ?? '';

  if (
    !anchor?.id ||
    !anchor.name ||
    !anchor.location ||
    !locationPattern.test(anchor.location) ||
    !Number.isInteger(budgetMinutes) ||
    budgetMinutes < 20 ||
    budgetMinutes > 90 ||
    (direction !== 'to' && direction !== 'from') ||
    !datePattern.test(departureDate) ||
    !timePattern.test(departureTime)
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
  const cacheKey = [
    anchor.id,
    anchor.location,
    budgetMinutes,
    direction,
    departureDate,
    departureTime,
  ].join('|');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json({ ...cached.value, cached: true });
  }

  const scanRadiusMeters = Math.min(8_000, Math.max(3_000, budgetMinutes * 80));
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

  try {
    const nearAnchor = await findStationsAround(anchor.location, 1_800);
    const sectors = await runThrottled(sectorCenters, 450, async (center) => {
      try {
        return await findStationsAround(center, sampleSearchRadius);
      } catch {
        return [];
      }
    });
    const anchorCitycode =
      nearAnchor.find((station) => station.citycode)?.citycode ??
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
    const candidates = [...candidateMap.values()];

    const planned = await runThrottled(candidates, 450, async (station) => ({
      station,
      route: await planTransit(
        station,
        validatedAnchor,
        anchorCitycode,
        direction,
        departureDate,
        departureTime,
      ),
    }));
    const successful = planned.filter(
      (item): item is typeof item & { route: NonNullable<typeof item.route> } =>
        Boolean(item.route),
    );
    const evaluated = successful.map<ReachableStation>(
      ({ station, route }) => ({
        ...station,
        durationSeconds: route.durationSeconds,
        durationMinutes: Math.ceil(route.durationSeconds / 60),
        straightLineMeters: straightLineDistance(
          validatedAnchor.location,
          station.location,
        ),
        segmentCount: route.segmentCount,
      }),
    );
    const reachable = evaluated
      .filter((station) => station.durationSeconds <= budgetMinutes * 60)
      .sort(
        (left, right) => right.straightLineMeters - left.straightLineMeters,
      );
    const nearMisses = evaluated
      .filter((station) => station.durationSeconds > budgetMinutes * 60)
      .sort((left, right) => left.durationSeconds - right.durationSeconds)
      .slice(0, 3);
    const result: ReachabilityResult = {
      sampled: true,
      budgetMinutes,
      scanRadiusMeters,
      candidateCount: candidates.length,
      checkedCount: successful.length,
      failedCount: candidates.length - successful.length,
      reachableCount: reachable.length,
      fastestCandidateMinutes:
        successful.length > 0
          ? Math.ceil(
              Math.min(
                ...successful.map((item) => item.route.durationSeconds),
              ) / 60,
            )
          : null,
      farthest: reachable[0] ?? null,
      nearMisses,
      stations: reachable.slice(0, 12),
    };

    cache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: result });
    return Response.json(result);
  } catch (error) {
    return amapErrorResponse(error);
  }
}
