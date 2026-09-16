import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { sameProject } from '../../web/lib/model.js';

const site = 'http://127.0.0.1:4274/SpriteCanvas/';
const projectDownload = async page => {
  const pending = page.waitForEvent('download');
  await page.locator('.document-actions [data-action="save"]').click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
};

test('fresh static startup is blank without fetching reference artwork, and its saved identity survives reload', async ({ page }) => {
  const referenceRequests = [];
  await page.route('**/examples/helmet.spritecanvas.json', route => {
    referenceRequests.push(route.request().url()); return route.abort('blockedbyclient');
  });
  await page.goto(site);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#project-name')).toHaveText('Untitled sprite');
  const blank = await projectDownload(page);
  expect([blank.width, blank.height, blank.layers.length, blank.frames.length]).toEqual([32, 32, 1, 1]);
  expect(blank.frames[0].cels[blank.layers[0].id].every(pixel => pixel === null)).toBe(true);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  expect(sameProject(await projectDownload(page), blank)).toBe(true);
  expect(referenceRequests).toEqual([]);
});

test('reference artwork loads only on request and saved reference artwork is not erased on startup', async ({ page }) => {
  await page.goto(site);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#project-name')).toHaveText('Untitled sprite');
  await page.locator('[data-action="reference"]').click();
  await expect(page.locator('#project-name')).toHaveText('Golden helmet');
  await expect(page.locator('#save-status')).toHaveText('Autosaved in this browser');
  const reference = JSON.parse(await readFile(new URL('../../web/examples/helmet.spritecanvas.json', import.meta.url), 'utf8'));
  expect(sameProject(await projectDownload(page), reference)).toBe(true);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  expect(sameProject(await projectDownload(page), reference)).toBe(true);
});
