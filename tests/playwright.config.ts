// Acceptance tests against real services: two strfry relays, two Kubo nodes and
// the tracker (pnpm infra:up), demo data (pnpm demo:prepare), plus the artifacts
// server and the built web apps (the developer app and the simple app), which Playwright
// starts here.
//
//   pnpm test:e2e     deterministic service/browser checks (tiny real model only)
//   pnpm test:models  opt-in real-model runs (downloads ~0.9 GB into the browser)
import { defineConfig } from '@playwright/test';

const WEB = process.env.WEXARE_WEB_URL ?? 'http://localhost:4173';
const SIMPLE = process.env.WEXARE_SIMPLE_URL ?? 'http://localhost:4174';
/** Example links for the simple app's header (WEXARE_SOURCE_CODE, WEXARE_MAKER_SITE); tests/support/env.ts has the same. */
const SOURCE_CODE = 'https://github.com/example/modelxare';
const MAKER_SITE = 'https://maker.example.org';

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  // Shared relays/Kubo/indexer ports and relay stop/start: one worker, in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  globalSetup: './support/global-setup.ts',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure', actionTimeout: 30_000 },
  expect: { timeout: 20_000 },
  webServer: [
    {
      command: 'pnpm --dir .. --filter @wexare/artifacts run dev',
      url: 'http://127.0.0.1:8790/status',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --dir .. --filter @wexare/web run build && pnpm --dir .. --filter @wexare/web exec vite preview --port 4173 --strictPort',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      command: 'pnpm --dir .. --filter @wexare/simple run build && pnpm --dir .. --filter @wexare/simple exec vite preview --port 4174 --strictPort',
      env: { WEXARE_SOURCE_CODE: SOURCE_CODE, WEXARE_MAKER_SITE: MAKER_SITE },
      url: SIMPLE,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
  projects: [
    { name: 'e2e', testDir: './e2e', timeout: 600_000 },
    { name: 'models', testDir: './models', timeout: 3_600_000 },
  ],
});
