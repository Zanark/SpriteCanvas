import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { applyOperations, composite, createProject, sameProject } from '../../web/lib/model.js';

const site = 'http://127.0.0.1:4274/SpriteCanvas/';
const bg = 'rgb(0, 0, 0)', panel = 'rgb(0, 30, 38)', text = 'rgb(147, 161, 161)', cyan = 'rgb(42, 161, 152)';
const save = async page => {
  const pending = page.waitForEvent('download');
  await page.locator('.document-actions [data-action="save"]').click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
};
const canvasPixels = locator => locator.evaluate(canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data]);

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`DeepSeaFoam covers studio and review UI without recoloring artwork at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(site);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#001e26');
    await expect(page.locator('body')).toHaveCSS('background-color', bg);
    await expect(page.locator('body')).toHaveCSS('color', text);
    await expect(page.locator('#stage')).toHaveCSS('background-color', bg);
    await expect(page.locator('#stage')).toHaveCSS('background-image', 'none');
    expect(await page.locator('#stage').evaluate(stage => getComputedStyle(stage, '::before').content)).toBe('none');
    for (const selector of ['.app-header', '.tool-rail', '.options-bar', '.timeline', '.inspector']) {
      await expect(page.locator(selector)).toHaveCSS('background-color', panel);
    }
    for (const selector of ['#hex-color', '.layer.selected', '.frame.active', '[data-tool="pencil"]']) {
      await expect(page.locator(selector)).toHaveCSS('background-color', bg);
    }
    const primary = page.locator('.document-actions .primary');
    await expect(primary).toHaveCSS('background-color', cyan);
    await expect(primary).toHaveCSS('color', bg);
    await expect(page.locator('[data-tool="pencil"]')).toHaveCSS('border-color', cyan);
    await page.locator('#hex-color').focus();
    await expect(page.locator('#hex-color')).toHaveCSS('outline-color', cyan);
    await expect(page.locator('#hex-color')).toHaveCSS('outline-style', 'solid');
    await page.locator('.document-actions [data-action="new"]').click();
    await expect(page.locator('#new-dialog')).toHaveCSS('background-color', bg);
    await page.locator('#new-dialog [data-close]').click();

    const original = applyOperations(createProject(8, 8, 'Theme preservation fixture'), [
      { op: 'pixel', x: 1, y: 1, color: '#BDF078' },
      { op: 'pixel', x: 2, y: 2, color: '#123456' },
      { op: 'pixel', x: 3, y: 3, color: '#FF00FF' },
    ]);
    await page.locator('#open-file').setInputFiles({
      name: 'theme.spritecanvas.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)),
    });
    await expect(page.locator('#project-name')).toHaveText(original.name);
    await expect(page.locator('#save-status')).toHaveText('Autosaved in this browser');
    expect(await canvasPixels(page.locator('#art-canvas'))).toEqual([...composite(original)]);
    await expect(page.locator('.canvas-wrap')).toHaveCSS('background-color', 'rgb(208, 209, 201)');
    await page.locator('#mirror-x').click();
    await page.locator('#grid-toggle').click();
    await page.mouse.move(0, 0);
    expect(await page.locator('#overlay-canvas').evaluate(canvas => canvas.getContext('2d').strokeStyle)).toBe('rgba(42, 161, 152, 0.533)');
    expect(await canvasPixels(page.locator('#art-canvas'))).toEqual([...composite(original)]);
    expect(sameProject(await save(page), original)).toBe(true);

    const candidate = applyOperations(original, [{ op: 'pixel', x: 4, y: 4, color: '#FFFFFF' }]);
    await page.locator('#proposal-file').setInputFiles({
      name: 'proposal.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'spritecanvas-proposal', version: 1, title: 'Theme review fixture',
        baseProject: original, project: candidate,
      })),
    });
    await expect(page.locator('#compare-dialog')).toBeVisible();
    await expect(page.locator('#compare-dialog')).toHaveCSS('background-color', bg);
    await page.locator('[data-compare-mode="wipe"]').click();
    expect(await page.locator('#after-canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(4, 0, 1, 1).data]))
      .toEqual([42, 161, 152, 255]);
    await page.locator('[data-compare-mode="side"]').click();
    expect(await canvasPixels(page.locator('#before-canvas'))).toEqual([...composite(original)]);
    expect(await canvasPixels(page.locator('#after-canvas'))).toEqual([...composite(candidate)]);
    await page.locator('#request-changes-button').click();
    await expect(page.locator('#feedback-form')).toHaveCSS('background-color', panel);
    await expect(page.locator('#feedback-message')).toHaveCSS('background-color', bg);
    await page.locator('#feedback-message').fill('Keep the original colors.');
    await page.locator('#feedback-message').focus();
    await expect(page.locator('#feedback-message')).toHaveCSS('outline-color', cyan);
    await page.screenshot({ path: testInfo.outputPath('solarized-review.png'), fullPage: true });
    const packet = page.waitForEvent('download');
    await page.locator('#submit-feedback').click();
    await packet;
    await expect(page.locator('.review-entry').first()).toHaveCSS('background-color', bg);
    await page.locator('#compare-dialog [data-close]').click();
    expect(sameProject(await save(page), original)).toBe(true);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    expect(sameProject(await save(page), original)).toBe(true);
    expect(await canvasPixels(page.locator('#art-canvas'))).toEqual([...composite(original)]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: testInfo.outputPath('solarized-studio.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}
