import { amapRequest, AMapServerError } from '@/lib/amap-server';
import { BoundedCache } from '@/lib/reachability-core';
import {
  validSeed,
  validStop,
  verifyCommunityRoutes,
} from '@/lib/community-core';
import type { CommunityTransit } from '@/lib/community-core';
import type { Community, CommunityVerification } from '@/lib/community-types';
import { validDepartureDate } from '@/lib/departure-date';
import {
  classifyCommunity,
  communityRouteKey,
  ROUTE_FRESH_MS,
} from '@/lib/cache-policy';

type Poi = {
  id?: string;
  name?: string;
  location?: string;
  typecode?: string;
  address?: string | string[];
  distance?: string;
};
type SearchResponse = { status: string; count?: string; pois?: Poi[] };
type TransitResponse = {
  status: string;
  route?: { transits?: CommunityTransit[] };
};
const poiCache = new BoundedCache<{
  pois: Omit<Community, 'seedIds'>[];
  hasMore: boolean;
  checkedAt: number;
}>(64, 1024 * 1024);
const routeCache = new BoundedCache<CommunityVerification>(96, 4 * 1024 * 1024);
let nextRequestAt = 0;
async function pace() {
  const delay = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(Date.now(), nextRequestAt) + 350;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}
function invalid(message: string) {
  return Response.json(
    { error: { message, code: 'INVALID_COMMUNITY_QUERY' } },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  let body;
  try {
    const input = await request.text();
    if (input.length > 80_000) return invalid('查询内容过大，请减少选择。');
    body = JSON.parse(input);
  } catch {
    return invalid('查询格式不正确。');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !['search', 'verify'].includes(body.action)
  )
    return invalid('请选择小区搜索或通勤核验。');

  if (body.action === 'search') {
    const { station, seedIds, radius, page = 1 } = body;
    if (
      !validStop(station) ||
      !Array.isArray(seedIds) ||
      seedIds.length < 1 ||
      seedIds.length > 24 ||
      !seedIds.every(
        (id: unknown) => typeof id === 'string' && id.length <= 500,
      ) ||
      ![500, 1000].includes(radius) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 3
    )
      return invalid(
        '请选择有效站点及 500 米或 1 公里范围，每站最多查询 3 页。',
      );
    const key = JSON.stringify([station.id, station.location, radius, page]);
    try {
      let value = body.refresh ? undefined : poiCache.get(key);
      const cached = Boolean(value);
      if (!value) {
        await pace();
        request.signal.throwIfAborted();
        const data = await amapRequest<SearchResponse>(
          '/v5/place/around',
          new URLSearchParams({
            location: station.location,
            types: '120302',
            radius: String(radius),
            sortrule: 'distance',
            page_size: '20',
            page_num: String(page),
          }),
          { retries: 0, timeoutMilliseconds: 8000 },
        );
        const pois = (data.pois ?? [])
          .filter(
            (poi) =>
              poi.typecode?.split('|').includes('120302') && validStop(poi),
          )
          .map((poi) => ({
            id: poi.id!,
            name: poi.name!,
            location: poi.location!,
            address: Array.isArray(poi.address)
              ? poi.address.join(' ')
              : (poi.address ?? ''),
            distanceMeters: Number.isFinite(Number(poi.distance))
              ? Math.max(0, Number(poi.distance))
              : 0,
          }));
        value = {
          pois,
          hasMore: (data.pois?.length ?? 0) >= 20,
          checkedAt: Date.now(),
        };
        poiCache.set(key, value, 24 * 60 * 60_000);
      }
      return Response.json({
        communities: value.pois.map((poi) => ({ ...poi, seedIds })),
        hasMore: value.hasMore,
        page,
        cached,
        checkedAt: value.checkedAt,
      });
    } catch (error) {
      return Response.json(
        {
          error: {
            message:
              error instanceof AMapServerError
                ? error.message
                : '小区查询失败，请稍后重试。',
          },
        },
        { status: 502 },
      );
    }
  }

  const {
    seed,
    community,
    anchor,
    budgetMinutes,
    departureDate,
    departureTime,
  } = body;
  if (
    !validSeed(seed) ||
    !validStop(community) ||
    !validStop(anchor) ||
    !Number.isFinite(budgetMinutes) ||
    budgetMinutes < 20 ||
    budgetMinutes > 90 ||
    typeof departureDate !== 'string' ||
    !validDepartureDate(departureDate) ||
    !Number.isFinite(Date.parse(`${departureDate}T00:00:00+08:00`)) ||
    typeof departureTime !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime)
  )
    return invalid('通勤条件或站点信息失效，请重新计算通勤圈。');
  const key = communityRouteKey(
    community,
    anchor,
    seed,
    departureDate,
    departureTime,
  );
  if (body.refresh) routeCache.delete(key);
  const cached = routeCache.get(key);
  if (cached)
    return Response.json({
      ...classifyCommunity(cached, budgetMinutes * 60),
      cached: true,
    });
  try {
    await pace();
    request.signal.throwIfAborted();
    // Use the user's departure time at the community itself. This lets AMap
    // account for the first walk before boarding, rather than reuse an earlier train.
    const data = await amapRequest<TransitResponse>(
      '/v5/direction/transit/integrated',
      new URLSearchParams({
        origin: community.location,
        destination: anchor.location,
        originpoi: community.id,
        destinationpoi: anchor.id,
        city1: seed.citycode,
        city2: seed.citycode,
        strategy: '8',
        AlternativeRoute: '3',
        date: departureDate,
        time: departureTime.replace(':', '-'),
        show_fields: 'cost,polyline',
      }),
      { retries: 0, timeoutMilliseconds: 8000 },
    );
    const result = verifyCommunityRoutes(
      data.route?.transits ?? [],
      seed,
      community.id,
      budgetMinutes * 60,
    );
    if (result.status === 'reachable' || result.status === 'over_budget')
      routeCache.set(key, result, ROUTE_FRESH_MS);
    return Response.json(result);
  } catch (error) {
    return Response.json({
      communityId: community.id,
      seedId: seed.id,
      status: 'error',
      geometry: [],
      checkedAt: Date.now(),
      cached: false,
      message:
        error instanceof AMapServerError
          ? error.message
          : '通勤核验失败，请重试；本次不作不可达判断。',
    } satisfies CommunityVerification);
  }
}
