import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/docs',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: 'list',
  outputDir: 'test-results/docs-capture',
  use: {
    baseURL: 'http://127.0.0.1:4373',
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.mjs --port 4373 --workspace test-results/docs-workspace',
    url: 'http://127.0.0.1:4373/api/health',
    reuseExistingServer: false,
  },
});
