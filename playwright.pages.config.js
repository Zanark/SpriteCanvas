import { defineConfig } from '@playwright/test';

const site = new URL(process.env.SPRITECANVAS_SITE_URL || 'https://zanark.github.io/SpriteCanvas/');
if (!['http:', 'https:'].includes(site.protocol) || !site.pathname.endsWith('/')) {
  throw new Error('SPRITECANVAS_SITE_URL must be an HTTP(S) site root ending in /.');
}

export default defineConfig({
  testDir: './tests/pages',
  outputDir: './test-results/pages',
  workers: 1,
  timeout: 180000,
  expect: { timeout: 15000 },
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: site.href,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
