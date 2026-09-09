import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig(async ({ command, mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const localEnv = loadEnv(mode, '../..', '');
  const localVars = Object.fromEntries(
    [
      'NEXT_PUBLIC_AMAP_JS_KEY',
      'NEXT_PUBLIC_AMAP_JS_SECURITY_CODE',
      'AMAP_WEB_SERVICE_KEY',
      'AMAP_API_BASE_URL',
      'AMAP_DEFAULT_CITY_CODE',
    ]
      .map((name) => [name, localEnv[name]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );

  const localBindingConfig = {
    main: 'vinext/server/fetch-handler',
    compatibility_flags: ['nodejs_compat'],
    vars: command === 'serve' ? localVars : {},
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: 'site-creator-d1',
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: 'site-creator-r2',
          },
        ]
      : [],
  };

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    envDir: '../..',
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
