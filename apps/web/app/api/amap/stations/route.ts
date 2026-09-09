import { amapErrorResponse, amapRequest } from '@/lib/amap-server';

type AMapPoi = {
  id?: string;
  name?: string;
  location?: string;
  distance?: string;
  typecode?: string;
  address?: string | string[];
  citycode?: string;
  adcode?: string;
};

type AroundResponse = {
  status: string;
  info: string;
  infocode: string;
  pois?: AMapPoi[];
};

const locationPattern = /^-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?$/;

function normalizeAddress(address: AMapPoi['address']) {
  return Array.isArray(address) ? address.join(';') : (address ?? '');
}

function parseTransitLines(address: string) {
  return [...new Set(address.split(/[;；]/).map((line) => line.trim()))].filter(
    Boolean,
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const location = searchParams.get('location')?.trim() ?? '';
  const requestedRadius = Number(searchParams.get('radius') ?? 1200);

  if (!locationPattern.test(location)) {
    return Response.json(
      { error: { code: 'INVALID_LOCATION', message: '地点坐标格式不正确。' } },
      { status: 400 },
    );
  }

  const radius = Math.min(Math.max(Math.round(requestedRadius), 300), 3000);
  const params = new URLSearchParams({
    location,
    radius: String(radius),
    types: '150500|150600|150700',
    sortrule: 'distance',
    page_size: '25',
    show_fields: 'children,navi',
  });

  try {
    const result = await amapRequest<AroundResponse>(
      '/v5/place/around',
      params,
    );
    const stations = (result.pois ?? [])
      .filter(
        (
          poi,
        ): poi is AMapPoi & { id: string; name: string; location: string } =>
          Boolean(poi.id && poi.name && poi.location?.includes(',')),
      )
      .map((poi) => {
        const address = normalizeAddress(poi.address);
        return {
          id: poi.id,
          name: poi.name.replace(/\(公交站\)$/, ''),
          location: poi.location,
          distanceMeters: Number(poi.distance ?? 0),
          mode: poi.typecode?.startsWith('1505')
            ? 'SUBWAY'
            : poi.typecode?.startsWith('1506')
              ? 'LIGHT_RAIL'
              : 'BUS',
          address,
          lines: parseTransitLines(address),
          citycode: poi.citycode ?? '',
          adcode: poi.adcode ?? '',
        };
      });

    return Response.json({ radius, stations });
  } catch (error) {
    return amapErrorResponse(error);
  }
}
