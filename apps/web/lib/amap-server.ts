type AMapEnvelope = {
  status?: string;
  info?: string;
  infocode?: string;
};

export class AMapServerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AMapServerError';
  }
}

type AMapEnvName =
  | 'NEXT_PUBLIC_AMAP_JS_KEY'
  | 'NEXT_PUBLIC_AMAP_JS_SECURITY_CODE'
  | 'AMAP_WEB_SERVICE_KEY'
  | 'AMAP_API_BASE_URL'
  | 'AMAP_DEFAULT_CITY_CODE';

export function readServerEnv(name: AMapEnvName): string | undefined {
  switch (name) {
    case 'NEXT_PUBLIC_AMAP_JS_KEY':
      return (
        import.meta.env.NEXT_PUBLIC_AMAP_JS_KEY ??
        process.env.NEXT_PUBLIC_AMAP_JS_KEY
      );
    case 'NEXT_PUBLIC_AMAP_JS_SECURITY_CODE':
      return (
        import.meta.env.NEXT_PUBLIC_AMAP_JS_SECURITY_CODE ??
        process.env.NEXT_PUBLIC_AMAP_JS_SECURITY_CODE
      );
    case 'AMAP_WEB_SERVICE_KEY':
      return process.env.AMAP_WEB_SERVICE_KEY;
    case 'AMAP_API_BASE_URL':
      return import.meta.env.AMAP_API_BASE_URL ?? process.env.AMAP_API_BASE_URL;
    case 'AMAP_DEFAULT_CITY_CODE':
      return (
        import.meta.env.AMAP_DEFAULT_CITY_CODE ??
        process.env.AMAP_DEFAULT_CITY_CODE
      );
  }
}

export async function amapRequest<T extends AMapEnvelope>(
  pathname: string,
  params: URLSearchParams,
  options: { retries?: number; timeoutMilliseconds?: number } = {},
): Promise<T> {
  const key = readServerEnv('AMAP_WEB_SERVICE_KEY');
  if (!key) {
    throw new AMapServerError(
      '高德 Web 服务 Key 尚未配置。',
      'AMAP_CONFIG_MISSING',
      503,
    );
  }

  const baseUrl =
    readServerEnv('AMAP_API_BASE_URL') ?? 'https://restapi.amap.com';
  const url = new URL(pathname, baseUrl);
  params.forEach((value, name) => url.searchParams.set(name, value));
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'json');

  const attempts = 1 + (options.retries ?? 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 12_000),
      });
    } catch {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        continue;
      }
      throw new AMapServerError(
        '高德服务暂时无法连接。',
        'AMAP_UPSTREAM_UNAVAILABLE',
        502,
      );
    }

    if (!response.ok) {
      throw new AMapServerError(
        '高德服务返回了异常状态。',
        'AMAP_UPSTREAM_ERROR',
        502,
      );
    }

    const data = (await response.json()) as T;
    if (data.status === '1') return data;

    const rateLimited = data.infocode?.startsWith('1002');
    if (rateLimited && attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      continue;
    }

    throw new AMapServerError(
      rateLimited
        ? '地图服务请求过于频繁，请稍后重试。'
        : '高德未返回有效结果。',
      rateLimited ? 'AMAP_RATE_LIMITED' : 'AMAP_REQUEST_FAILED',
      rateLimited ? 429 : 502,
    );
  }

  throw new AMapServerError(
    '高德服务暂时无法连接。',
    'AMAP_UPSTREAM_UNAVAILABLE',
    502,
  );
}

export function amapErrorResponse(error: unknown): Response {
  if (error instanceof AMapServerError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.statusCode },
    );
  }

  return Response.json(
    { error: { code: 'UNKNOWN_ERROR', message: '服务暂时不可用。' } },
    { status: 500 },
  );
}
