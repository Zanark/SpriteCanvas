import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject, sameProject } from '../../web/lib/model.js';

test('published site is the editor, with working offline drawing, persistence and export', async ({ page, request, baseURL }, testInfo) => {
  const expectedCommit = process.env.SPRITECANVAS_EXPECTED_SHA;
  if (expectedCommit && !/^[a-f0-9]{40}$/.test(expectedCommit)) {
    throw new Error('SPRITECANVAS_EXPECTED_SHA must be a full 40-character Git commit.');
  }
  await expect.poll(async () => {
    const url = new URL('build-info.json', baseURL);
    url.searchParams.set('verify', `${expectedCommit || 'live'}-${Date.now()}`);
    const response = await request.get(url.href);
    if (!response.ok()) return `HTTP ${response.status()}`;
    const info = await response.json();
    if (info.format !== 'spritecanvas-site' || info.version !== 1) return 'Unexpected build metadata';
    return expectedCommit ? info.commit : 'available';
  }, { timeout: 90000, intervals: [1000, 2000, 5000], message: 'The new Pages artifact must reach the public site' })
    .toBe(expectedCommit || 'available');

  const errors = [], brokenAssets = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && !url.pathname.includes('/api/')) brokenAssets.push(`${response.status()} ${url.pathname}`);
  });
  await page.goto(baseURL);
  await expect(page).toHaveTitle('SpriteCanvas - Pixel studio');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 43, 54)');
  await expect(page.locator('.app-header')).toHaveCSS('background-color', 'rgb(7, 54, 66)');
  await expect(page.locator('.document-actions .primary')).toHaveCSS('background-color', 'rgb(42, 161, 152)');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#002b36');
  await expect(page.locator('#bridge-badge')).toHaveText('STATIC');
  await expect(page.locator('#overlay-canvas')).toBeVisible();
  await expect(page.getByRole('link', { name: 'SpriteCanvas home' })).toBeVisible();
  expect(await page.locator('.brand-mark').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const download = async action => {
    const pending = page.waitForEvent('download');
    await action();
    return readFile(await (await pending).path());
  };
  const save = () => download(() => page.locator('.document-actions [data-action="save"]').click());
  const blank = JSON.parse((await save()).toString());
  expect(blank.name).toBe('Untitled sprite');
  expect([blank.width, blank.height, blank.layers.length, blank.frames.length]).toEqual([32, 32, 1, 1]);
  expect(blank.frames[0].cels[blank.layers[0].id].every(pixel => pixel === null)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('published-empty-startup.png'), fullPage: true });

  // A fresh browser context owns this fixture; no real user's IndexedDB or bridge is touched.
  const fixture = createProject(16, 16, 'Pages smoke fixture');
  await page.locator('#open-file').setInputFiles({
    name: 'pages-smoke.spritecanvas.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator('#project-name')).toHaveText(fixture.name);
  await page.locator('[data-tool="pencil"]').click();
  await page.locator('#hex-color').fill('#FFAD13');
  await page.locator('#hex-color').press('Tab');
  const bounds = await page.locator('#overlay-canvas').boundingBox();
  await page.mouse.click(bounds.x + 2.5 * bounds.width / 16, bounds.y + 2.5 * bounds.height / 16);
  await expect(page.locator('#save-status')).toHaveText('Autosaved in this browser');
  const drawn = JSON.parse((await save()).toString());
  expect(drawn.frames[0].cels[drawn.layers[0].id][2 * 16 + 2]).toBe('#FFAD13FF');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  expect(sameProject(JSON.parse((await save()).toString()), drawn)).toBe(true);
  await page.locator('.document-actions [data-action="export"]').click();
  await page.locator('#export-format').selectOption('png');
  await page.locator('#export-scale').selectOption('1');
  const png = await download(() => page.locator('#export-form button[type="submit"]').click());
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([16, 16]);
  await page.screenshot({ path: testInfo.outputPath('published-editor-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#overlay-canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('published-editor-mobile.png'), fullPage: true });

  for (const name of ['README.md', '.spritecanvas/workspace.json', '.agent-context/STATE.md']) {
    const url = new URL(name, baseURL); url.searchParams.set('verify', Date.now());
    expect((await request.get(url.href)).status(), `${name} must not be in the deployed artifact`).toBe(404);
  }
  expect(errors).toEqual([]); expect(brokenAssets).toEqual([]); expect(writes).toEqual([]);
});
