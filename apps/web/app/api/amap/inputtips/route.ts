import {
  amapErrorResponse,
  amapRequest,
  readServerEnv,
} from '@/lib/amap-server';

type InputTip = {
  id?: string;
  name?: string;
  district?: string;
  adcode?: string;
  location?: string | [];
  address?: string;
  typecode?: string;
};

type InputTipsResponse = {
  status: string;
  info: string;
  infocode: string;
  tips?: InputTip[];
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keywords = searchParams.get('keywords')?.trim();

  if (!keywords || keywords.length > 80) {
    return Response.json(
      {
        error: {
          code: 'INVALID_KEYWORDS',
          message: '请输入 1～80 个字符的地点名称。',
        },
      },
      { status: 400 },
    );
  }

  const params = new URLSearchParams({ keywords, datatype: 'poi' });
  const city =
    searchParams.get('city') ?? readServerEnv('AMAP_DEFAULT_CITY_CODE');
  if (city) {
    params.set('city', city);
    params.set('citylimit', 'true');
  }

  try {
    const result = await amapRequest<InputTipsResponse>(
      '/v3/assistant/inputtips',
      params,
    );
    const tips = (result.tips ?? [])
      .filter(
        (
          tip,
        ): tip is InputTip & { id: string; name: string; location: string } =>
          Boolean(
            tip.id &&
            tip.name &&
            typeof tip.location === 'string' &&
            tip.location.includes(','),
          ),
      )
      .slice(0, 8)
      .map((tip) => ({
        id: tip.id,
        name: tip.name,
        district: tip.district ?? '',
        adcode: tip.adcode ?? '',
        location: tip.location,
        address: tip.address ?? '',
        typecode: tip.typecode ?? '',
      }));

    return Response.json({ tips });
  } catch (error) {
    return amapErrorResponse(error);
  }
}
