import { readServerEnv } from '@/lib/amap-server';

export async function GET() {
  const jsKey = readServerEnv('NEXT_PUBLIC_AMAP_JS_KEY');
  const securityCode = readServerEnv('NEXT_PUBLIC_AMAP_JS_SECURITY_CODE');

  if (!jsKey || !securityCode) {
    return Response.json(
      {
        error: {
          code: 'AMAP_JS_CONFIG_MISSING',
          message: '高德 JS API 配置尚未完成。',
        },
      },
      { status: 503 },
    );
  }

  return Response.json(
    { jsKey, securityCode },
    { headers: { 'Cache-Control': 'private, max-age=300' } },
  );
}
