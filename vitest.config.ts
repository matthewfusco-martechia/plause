import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.WRANGLER_LOG_PATH = '.local/test-wrangler.log';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        APP_ENV: 'local',
        MODEL_PROVIDER: 'mock',
        MESSAGING_PROVIDER: 'mock',
        LIVE_MODEL_ENABLED: 'false',
        OPENAI_API_KEY: '',
        SEARCH_PROVIDER: 'disabled',
        LIVE_SEARCH_ENABLED: 'false',
        TAVILY_API_KEY: '',
        AUTH_GOOGLE_ENABLED: 'false',
        AUTH_SIGNUP_ENABLED: 'false',
        AUTH_SIGNUP_SUBJECTS: '',
        AUTH_GOOGLE_CLIENT_ID: '',
        AUTH_GOOGLE_CLIENT_SECRET: '',
        OPERATOR_BOOTSTRAP_SUBJECTS: '[]',
        SEARCH_USER_DAILY_LIMIT: '20',
        SEARCH_GLOBAL_DAILY_LIMIT: '500',
        OPENAI_MODEL: 'gpt-6-luna',
        MODEL_MAX_INPUT_TOKENS: '4096',
        MODEL_MAX_OUTPUT_TOKENS: '600',
        MODEL_TIMEOUT_MS: '20000',
        MODEL_USER_MONTHLY_BUDGET_MICRO_USD: '5000000',
        MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: '50000000',
        CONTENT_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        MOCK_WEBHOOK_SECRET: 'test-webhook-secret-never-used-outside-tests',
        OPERATOR_TOKEN: 'test-operator-secret-never-used-outside-tests',
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'], fileParallelism: false },
});
