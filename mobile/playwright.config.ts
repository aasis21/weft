import { defineConfig } from '@playwright/test';

const PORT = 4317;
const BASE = `http://localhost:${PORT}`;

// Mobile-first smoke tests for the Weft chat UI. Runs against `vite preview`
// (the production build in dist/), so build before running: `npm run test:e2e`.
export default defineConfig({
  testDir: './tests',
  // Only Playwright specs end in `.spec.ts`; Vitest unit/scenario files use `.test.ts(x)`
  // under `src/`, so this keeps the two runners from ever picking up each other's files.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
