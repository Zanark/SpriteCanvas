import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { addFrame, addLayer, clone, color, sameProject, validateProject } from '../../web/lib/model.js';
import { sourceHash } from '../../scripts/check-docs.mjs';

const output = path.join('docs', 'assets', 'screenshots');
const baseURL = 'http://127.0.0.1:4373';
const fixtureSources = [
  'web/examples/helmet.spritecanvas.json', 'web/assets/spritecanvas-logo.spritecanvas.json',
];
const renderSources = [
  'web/index.html', 'web/app.js', 'web/styles.css', 'web/palette.css', 'web/review.css',
  'web/lib/model.js', 'web/lib/export.js', 'web/lib/gif.js', 'web/lib/review.js', 'web/lib/storage.js',
  'web/assets/spritecanvas-logo.svg', 'web/assets/spritecanvas-logo.png',
  'tests/docs/screenshots.spec.js', 'playwright.docs.config.js',
];
const hash = data => createHash('sha256').update(data).digest('hex');

test('capture captioned documentation from an isolated sample workspace', async ({ page, request, baseURL: configuredURL }) => {
  expect(new URL(configuredURL).port).toBe('4373');
  const errors = [], unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL) return route.continue();
    unexpectedRequests.push(url.href);
    return route.abort('blockedbyclient');
  });
  const workspace = async () => (await request.get(`${baseURL}/api/workspace`)).json();
  const post = async (route, data) => {
    const response = await request.post(`${baseURL}/api/${route}`, { data, headers: { 'X-SpriteCanvas': '1' } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const sample = validateProject(JSON.parse(await readFile(path.join('web', 'examples', 'helmet.spritecanvas.json'), 'utf8')));
  sample.name = 'Golden helmet - animation study';
  const twinkle = addLayer(sample, 'Twinkle - editable pixels');
  for (let f = 0; f < 4; f++) {
    if (f) addFrame(sample, f - 1);
    sample.frames[f].duration = 180;
    sample.frames[f].cels[twinkle.id].fill(null);
    const x = [35, 36, 35, 34][f], y = [14, 15, 16, 15][f];
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      sample.frames[f].cels[twinkle.id][(y + dy) * sample.width + x + dx] = color('#FFF3E7');
    }
  }
  let current = await workspace();
  if (current.proposal) current = await post('reject', { expectedRevision: current.revision, proposalId: current.proposal.id });
  await post('project', { expectedRevision: current.revision, project: sample });
  await mkdir(output, { recursive: true });
  const images = [];
  const capture = async (name, caption, locator = page) => {
    await page.mouse.move(0, 0);
    const bytes = await locator.screenshot({ path: path.join(output, name), animations: 'disabled' });
    images.push({ file: name, caption, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: hash(bytes) });
  };
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#bridge-badge')).toHaveText('LOCAL LIVE');
  await expect(page.locator('#frames [data-frame]')).toHaveCount(4);
  await expect(page.locator('.brand-mark')).toBeVisible();
  await capture('studio-overview.png', 'The real studio with the bundled helmet reconstruction and a generated four-frame twinkle study. This is documentation sample artwork, not the private workspace.');

  await page.locator('[data-tool="select"]').click();
  const bounds = await page.locator('#overlay-canvas').boundingBox();
  const point = (x, y) => ({ x: bounds.x + (x + 0.5) * bounds.width / sample.width, y: bounds.y + (y + 0.5) * bounds.height / sample.height });
  const start = point(16, 16), end = point(33, 34);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y); await page.mouse.up();
  await expect(page.locator('#selection-info')).toContainText('selection');
  await capture('selection-workflow.png', 'A marquee bounds work on the active cel; the selection does not flatten or combine the layers.');
  await page.locator('[data-action="deselect"]').click();

  await page.locator('.document-actions [data-action="export"]').click();
  await page.locator('#export-format').selectOption('gif');
  await page.locator('#export-scale').selectOption('16');
  await capture('export-options.png', 'The actual export dialog, configured for a looping GIF at 16x. Its notes explain palette, transparency and timing tradeoffs.', page.locator('#export-dialog'));
  await page.locator('#export-dialog').getByRole('button', { name: 'Close', exact: true }).click();

  const candidate = clone(sample), accents = addLayer(candidate, 'Agent sparkle accents');
  for (const frame of candidate.frames) for (const [x, y] of [[14, 27], [35, 29]]) {
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [0, 1], [0, -2], [0, 2]]) {
      frame.cels[accents.id][(y + dy) * candidate.width + x + dx] = color('#FFF052');
    }
  }
  current = await workspace();
  await post('proposals', { expectedRevision: current.revision, project: candidate, title: 'Add warm sparkle accents - documentation example' });
  await page.goto('/?review=1');
  await expect(page.locator('#compare-dialog')).toBeVisible();
  await capture('compare-versions.png', 'Side-by-side proposal review in the actual UI. Both versions are generated documentation fixtures; the baseline remains unchanged.', page.locator('#compare-dialog'));
  await page.locator('[data-compare-mode="diff"]').click();
  await capture('pixel-difference.png', 'Pixel difference isolates the proposed sparkle changes. Structural changes are listed separately below the images.', page.locator('#compare-dialog'));
  await page.locator('[data-compare-mode="side"]').click();
  await page.setViewportSize({ width: 1440, height: 1450 });
  await page.locator('#request-changes-button').click();
  await page.locator('#feedback-message').fill('Keep the original helmet and boots. Make the two sparkle accents smaller and keep them warm yellow.');
  await page.locator('#feedback-reference').setInputFiles(path.join('web', 'assets', 'spritecanvas-logo.png'));
  await expect(page.locator('#feedback-reference-preview')).toBeVisible();
  await capture('request-changes.png', 'A sample feedback draft with a bundled logo reference. Saving a request records guidance; it does not automatically message the agent.', page.locator('#compare-dialog'));
  await page.locator('[data-action="cancel-feedback"]').click();
  await page.locator('#compare-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  expect(sameProject((await workspace()).project, sample)).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await capture('studio-mobile.png', 'The same studio at a 390px viewport. The workspace reorganizes vertically; screenshots do not imply touch-device certification.');
  await page.setViewportSize({ width: 1440, height: 1050 });
  current = await workspace();
  await post('reject', { expectedRevision: current.revision, proposalId: current.proposal.id });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const logo = validateProject(JSON.parse(await readFile(path.join('web', 'assets', 'spritecanvas-logo.spritecanvas.json'), 'utf8')));
  await page.locator('#open-file').setInputFiles({ name: 'logo.spritecanvas.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(logo)) });
  await expect(page.locator('#project-name')).toHaveText(logo.name);
  await expect(page.locator('#layers .layer')).toHaveCount(6);
  await expect(page.locator('#save-status')).toContainText('Saved locally');
  await expect(page.locator('#notice')).toBeHidden();
  await capture('editable-logo.png', 'The original camera-facing GIF pose opened as six editable layers, including the warm lens flare. The favicon alone omits the flare.');
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  const sourceHashes = {};
  for (const name of [...fixtureSources, ...renderSources]) sourceHashes[name] = sourceHash(name, await readFile(path.join(...name.split('/'))));
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    version: 1, kind: 'real-ui-documentation-capture', fixtureSources, sourceHashes,
    isolation: { port: 4373, workspace: 'test-results/docs-workspace', privateWorkspaceRead: false, externalRequests: 0 },
    images,
  }, null, 2) + '\n');
});
