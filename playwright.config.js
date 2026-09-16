import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 8000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4273',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node server.mjs --port 4273 --workspace test-results/bridge-workspace', url: 'http://127.0.0.1:4273/api/health', reuseExistingServer: false },
    { command: 'node scripts/static-test-server.mjs', url: 'http://127.0.0.1:4274/SpriteCanvas/', reuseExistingServer: false },
  ],
});
