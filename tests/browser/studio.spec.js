import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProject, clone, color, applyOperations, sameProject, addFrame, addLayer, composite, fromRgba } from '../../web/lib/model.js';
import { encodePng } from '../../scripts/png.mjs';

const exec = promisify(execFile);
const bridgeUrl = 'http://127.0.0.1:4273';
const post = async (request, route, data) => {
  const response = await request.post(`${bridgeUrl}/api/${route}`, { data, headers: { 'X-SpriteCanvas': '1' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
};
const state = async (request) => (await request.get(`${bridgeUrl}/api/workspace`)).json();
const canvasPoint = async (page, x, y, width = 16) => {
  const bounds = await page.locator('#overlay-canvas').boundingBox();
  return { x: bounds.x + (x + 0.5) * bounds.width / width, y: bounds.y + (y + 0.5) * bounds.width / width };
};
const stroke = async (page, x, y, x2 = x, y2 = y, width = 16) => {
  const a = await canvasPoint(page, x, y, width), b = await canvasPoint(page, x2, y2, width);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
};
const hex = async (page, value) => {
  await page.locator('#hex-color').fill(value);
  await page.locator('#hex-color').press('Tab');
};
const saved = async (page) => expect(page.locator('#save-status')).toContainText('Saved locally');
const downloaded = async (page, action) => {
  const promise = page.waitForEvent('download'); await action();
  const result = await promise;
  return { name: result.suggestedFilename(), bytes: await readFile(await result.path()) };
};
const currentProjectDownload = async (page) => {
  const file = await downloaded(page, () => page.locator('.document-actions [data-action="save"]').click());
  return JSON.parse(file.bytes.toString());
};
const decodeGifFrames = async (page, project, scale = 1) => page.evaluate(async ({ project, scale }) => {
  const { encodeGif } = await import('./lib/gif.js');
  const decoder = new ImageDecoder({ data: encodeGif(project, scale), type: 'image/gif' });
  try {
    await decoder.tracks.ready;
    const frames = [];
    for (let frameIndex = 0; frameIndex < decoder.tracks.selectedTrack.frameCount; frameIndex++) {
      const { image } = await decoder.decode({ frameIndex });
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.displayWidth; canvas.height = image.displayHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        frames.push({ width: canvas.width, height: canvas.height, duration: image.duration,
          pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] });
      } finally {
        image.close();
      }
    }
    return frames;
  } finally {
    decoder.close();
  }
}, { project, scale });
const expectedGifPixels = (project, frame, scale = 1) => {
  const source = composite(project, frame), pixels = [];
  for (let y = 0; y < project.height * scale; y++) for (let x = 0; x < project.width * scale; x++) {
    const offset = (Math.floor(y / scale) * project.width + Math.floor(x / scale)) * 4;
    const alpha = source[offset + 3] / 255;
    pixels.push(...(alpha < 0.5 ? [0, 0, 0, 0] :
      [0, 1, 2].map((c) => Math.round(source[offset + c] * alpha + 255 * (1 - alpha))).concat(255)));
  }
  return pixels;
};

test.beforeEach(async ({ request }) => {
  let previous = await state(request);
  if (previous.proposal) previous = await post(request, 'reject', { expectedRevision: previous.revision, proposalId: previous.proposal.id });
  await post(request, 'project', { expectedRevision: previous.revision, project: createProject(16, 16, 'Browser test') });
});

test('large palettes have readable swatches and palette-only proposals preserve pixels and support undo', async ({ page, request }) => {
  const initial = await state(request);
  const original = clone(initial.project);
  original.palette = Array.from({ length: 256 }, (_, index) => color(`#${index.toString(16).padStart(2, '0')}5678`));
  original.frames[0].cels[original.layers[0].id][17] = original.palette[96];
  await post(request, 'project', { expectedRevision: initial.revision, project: original });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#palette-count')).toHaveText('256');
  await expect(page.locator('#palette .swatch')).toHaveCount(256);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1100, height: 800 }, { width: 400, height: 900 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.locator('#palette').evaluate((container) => {
      const rectangles = [...container.children].map((element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      });
      const overlaps = rectangles.some((a, i) => rectangles.slice(i + 1).some((b) =>
        a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y));
      return { overlaps, readable: rectangles.every((r) => r.width === 24 && r.height === 24), scrolls: container.scrollHeight > container.clientHeight };
    });
    expect(geometry).toEqual({ overlaps: false, readable: true, scrolls: true });
  }
  await page.locator('#palette .swatch').last().click();
  await expect(page.locator('#hex-color')).toHaveValue('#FF5678');
  const before = await state(request);
  expect(sameProject(before.project, original)).toBeTruthy();
  const candidate = clone(original);
  candidate.palette = candidate.palette.slice(0, 24);
  await post(request, 'proposals', { expectedRevision: before.revision, project: candidate, title: 'Compact working palette' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?review=1');
  await expect(page.locator('#palette-comparison')).toBeVisible();
  await expect(page.locator('#before-palette-count')).toHaveText('256');
  await expect(page.locator('#after-palette-count')).toHaveText('24');
  await expect(page.locator('#before-palette .swatch')).toHaveCount(256);
  await expect(page.locator('#after-palette .swatch')).toHaveCount(24);
  await expect(page.locator('#diff-count')).toContainText('0 changed rendered pixels');
  await expect(page.locator('#structure-changes')).toContainText('Palette 256 -> 24');
  await page.locator('#accept-button').click();
  await expect(page.locator('#palette-count')).toHaveText('24');
  await expect(page.locator('#palette .swatch')).toHaveCount(24);
  expect((await state(request)).project.frames).toEqual(original.frames);
  await page.locator('[data-action="undo"]').first().click();
  await saved(page);
  await expect(page.locator('#palette-count')).toHaveText('256');
  const restored = await state(request);
  expect(sameProject(restored.project, original)).toBeTruthy();
  const pixelOnly = applyOperations(original, [{ op: 'pixel', x: 2, y: 2, color: original.palette[0] }]);
  await post(request, 'proposals', { expectedRevision: restored.revision, project: pixelOnly, title: 'Pixels only' });
  await expect(page.locator('#proposal-title')).toHaveText('Pixels only');
  await page.locator('#compare-button').click();
  await expect(page.locator('#palette-comparison')).toBeHidden();
});

test('a local HTML preview link opens pending and accepted artwork without changing it', async ({ page, request }, testInfo) => {
  const initial = await state(request);
  const candidate = applyOperations(initial.project, [{ op: 'pixel', x: 3, y: 3, color: '#FFFFFF' }]);
  const submitted = await post(request, 'proposals', {
    expectedRevision: initial.revision, project: candidate, title: 'Local preview proposal',
  });
  const filename = testInfo.outputPath('local-preview.html');
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `<!doctype html><a href="${bridgeUrl}/?review=1">Review proposal in SpriteCanvas</a>`);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const openPreviewLink = async () => {
    await page.goto(pathToFileURL(filename).href);
    const pending = page.waitForResponse((response) => response.url() === `${bridgeUrl}/?review=1`);
    await page.getByRole('link', { name: 'Review proposal in SpriteCanvas' }).click();
    const response = await pending;
    expect(response.status()).toBe(200);
    const headers = await response.request().allHeaders();
    expect(headers['sec-fetch-site']).toBe('cross-site');
    expect(headers['sec-fetch-user']).toBe('?1');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  };
  await openPreviewLink();
  await expect(page.locator('#compare-dialog')).toBeVisible();
  await expect(page.locator('#compare-dialog')).toContainText('Local preview proposal');
  await expect(page.locator('#accept-button')).toBeEnabled();
  expect(sameProject((await state(request)).project, initial.project)).toBeTruthy();
  const accepted = await post(request, 'accept', { expectedRevision: initial.revision, proposalId: submitted.proposal.id });
  await openPreviewLink();
  if (!(await page.locator('#compare-dialog').isVisible())) await page.locator('#compare-button').click();
  await expect(page.locator('#compare-badge')).toHaveText('ACCEPTED SNAPSHOT');
  const current = await state(request);
  expect(current.revision).toBe(accepted.revision);
  expect(current.proposal).toBeNull();
  expect(sameProject(current.project, candidate)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('pencil, eraser, fill, selection, shapes, move, undo and persistence', async ({ page, request }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await hex(page, '#FF0000');
  await stroke(page, 1, 1, 6, 1); await saved(page);
  let doc = (await state(request)).project, pixels = doc.frames[0].cels[doc.layers[0].id];
  expect(pixels.filter(Boolean)).toHaveLength(6);
  await page.getByRole('button', { name: 'Eraser (E)', exact: true }).click();
  await stroke(page, 2, 1); await saved(page);
  doc = (await state(request)).project; expect(doc.frames[0].cels[doc.layers[0].id][18]).toBeNull();
  await page.keyboard.press('Control+z'); await saved(page);
  doc = (await state(request)).project; expect(doc.frames[0].cels[doc.layers[0].id][18]).toBe('#FF0000FF');
  await page.getByRole('button', { name: 'Marquee selection (M)', exact: true }).click();
  await stroke(page, 2, 3, 4, 5);
  await page.getByRole('button', { name: 'Rectangle (U)', exact: true }).click();
  await page.locator('#filled-shape').check();
  await stroke(page, 0, 2, 8, 8); await saved(page);
  doc = (await state(request)).project; pixels = doc.frames[0].cels[doc.layers[0].id];
  expect(pixels.filter(Boolean)).toHaveLength(15);
  expect(pixels[2 * 16]).toBeNull();
  await hex(page, '#00FF00');
  await page.getByRole('button', { name: 'Paint bucket (F)', exact: true }).click();
  await stroke(page, 3, 4); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id].filter((p) => p === '#00FF00FF')).toHaveLength(9);
  await page.getByRole('button', { name: 'Move (V)', exact: true }).click();
  await stroke(page, 3, 4, 5, 6); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id][3 * 16 + 2]).toBeNull();
  expect(doc.frames[0].cels[doc.layers[0].id][5 * 16 + 4]).toBe('#00FF00FF');
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  expect(sameProject(await currentProjectDownload(page), doc)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('layers, locks, opacity, frame duplication, timing, playback and PNG/GIF/sheet export', async ({ page, request }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await stroke(page, 3, 3);
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  await page.locator('#text-input').fill('Highlights');
  await page.locator('#text-form button[type="submit"]').click();
  await hex(page, '#FFFFFF'); await stroke(page, 3, 3);
  await page.locator('#layer-opacity').fill('50'); await page.locator('#layer-opacity').dispatchEvent('change');
  await saved(page);
  let doc = (await state(request)).project;
  expect(doc.layers).toHaveLength(2); expect(doc.layers[1].opacity).toBe(0.5);
  await page.getByRole('button', { name: 'Lock Highlights', exact: true }).click();
  await stroke(page, 4, 3);
  await expect(page.locator('#notice')).toContainText('locked');
  await page.getByRole('button', { name: 'Unlock Highlights', exact: true }).click();
  await page.locator('[data-action="duplicate-frame"]').click();
  await page.locator('#frame-duration').fill('240'); await page.locator('#frame-duration').press('Tab');
  await page.getByRole('button', { name: 'Eraser (E)', exact: true }).click();
  await stroke(page, 3, 3); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames).toHaveLength(2);
  expect(doc.frames[0].cels[doc.layers[1].id][51]).toBe('#FFFFFFFF');
  expect(doc.frames[1].cels[doc.layers[1].id][51]).toBeNull();
  expect(doc.frames[1].duration).toBe(240);
  await page.locator('#play-button').click(); await expect(page.locator('#play-button')).toHaveText('Pause');
  await page.waitForTimeout(400); await page.locator('#play-button').click();
  await page.getByRole('button', { name: 'Frame 2', exact: true }).click();
  await page.locator('.document-actions [data-action="export"]').click();
  await page.locator('#export-scale').selectOption('4');
  const png = await downloaded(page, () => page.locator('#export-form button[type="submit"]').click());
  expect(png.bytes.readUInt32BE(16)).toBe(64); expect(png.bytes.readUInt32BE(20)).toBe(64);
  await page.locator('.document-actions [data-action="export"]').click();
  await page.locator('#export-format').selectOption('gif'); await page.locator('#export-scale').selectOption('1');
  const gif = await downloaded(page, () => page.locator('#export-form button[type="submit"]').click());
  const decoded = await page.evaluate(async (data) => {
    const decoder = new ImageDecoder({ data: new Uint8Array(data), type: 'image/gif' });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack.frameCount;
    const frame = await decoder.decode({ frameIndex: 1 });
    const result = { count, width: frame.image.displayWidth, duration: frame.image.duration };
    frame.image.close(); decoder.close(); return result;
  }, [...gif.bytes]);
  expect(decoded).toEqual({ count: 2, width: 16, duration: 240000 });
  await page.locator('.document-actions [data-action="export"]').click();
  await page.locator('#export-format').selectOption('sheet'); await page.locator('#sheet-columns').fill('2');
  const downloads = []; page.on('download', (file) => downloads.push(file));
  await page.locator('#export-form button[type="submit"]').click();
  await expect.poll(() => downloads.length).toBe(2);
  const metadataFile = downloads.find((file) => file.suggestedFilename().endsWith('.json'));
  const metadata = JSON.parse(await readFile(await metadataFile.path(), 'utf8'));
  expect(metadata.frames).toHaveLength(2); expect(metadata.width).toBe(32); expect(metadata.frames[1].x).toBe(16);
});

test('agent CLI reads user pixels, proposes a new layer, and user compares before accepting', async ({ page, request }, testInfo) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await hex(page, '#123456'); await stroke(page, 2, 2); await saved(page);
  const folder = testInfo.outputPath('agent-files'); await mkdir(folder, { recursive: true });
  const handoffPath = path.join(folder, 'handoff.json'), candidatePath = path.join(folder, 'candidate.json');
  await exec(process.execPath, ['scripts/agent.mjs', 'pull', handoffPath, '--url', bridgeUrl]);
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
  expect(handoff.project.frames[0].cels[handoff.project.layers[0].id][34]).toBe('#123456FF');
  const candidate = applyOperations(handoff.project, [{ op: 'layer', name: 'Agent glow' }, { op: 'pixel', x: 3, y: 2, color: '#BDF078' }]);
  await writeFile(candidatePath, JSON.stringify(candidate));
  await exec(process.execPath, ['scripts/agent.mjs', 'propose', candidatePath, '--base', String(handoff.revision), '--title', 'One pixel of agent glow', '--url', bridgeUrl]);
  await expect(page.locator('#proposal-card')).toBeVisible();
  expect(sameProject((await state(request)).project, handoff.project)).toBeTruthy();
  await page.locator('#compare-button').click();
  await expect(page.locator('#diff-count')).toContainText('1 changed rendered pixel');
  await page.locator('[data-compare-mode="wipe"]').click(); await expect(page.locator('#wipe-control')).toBeVisible();
  await page.locator('#wipe-slider').fill('25');
  await page.locator('[data-compare-mode="diff"]').click();
  const diffPixel = await page.locator('#after-canvas').evaluate((canvas) => [...canvas.getContext('2d').getImageData(3, 2, 1, 1).data]);
  expect(diffPixel).toEqual([190, 246, 104, 255]);
  await page.locator('#accept-button').click(); await expect(page.locator('#compare-dialog')).not.toBeVisible();
  expect(sameProject((await state(request)).project, candidate)).toBeTruthy();
  await page.locator('#compare-button').click();
  await expect(page.locator('#compare-badge')).toHaveText('ACCEPTED SNAPSHOT');
  await page.locator('#compare-dialog [data-close]').click();
  await page.locator('[data-action="undo"]').click(); await saved(page);
  expect(sameProject((await state(request)).project, handoff.project)).toBeTruthy();
});

test('stale proposals remain inspectable but cannot overwrite later user drawing', async ({ page, request }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const initial = await state(request);
  const candidate = applyOperations(initial.project, [{ op: 'pixel', x: 3, y: 3, color: '#FFFFFF' }]);
  await post(request, 'proposals', { expectedRevision: initial.revision, project: candidate, title: 'Old proposal' });
  await expect(page.locator('#proposal-card')).toBeVisible();
  await stroke(page, 5, 5); await saved(page);
  await page.locator('#compare-button').click();
  await expect(page.locator('#compare-badge')).toHaveText('OUT OF DATE');
  await expect(page.locator('#accept-button')).toBeDisabled();
  await page.locator('#reject-button').click();
  const after = await state(request);
  expect(after.proposal).toBeNull();
  expect(after.project.frames[0].cels[after.project.layers[0].id][85]).toBe('#FFAF24FF');
});

test('concurrent disk edits cause a visible conflict and browser recovery survives reload', async ({ page, request }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  let intercepted = false;
  await page.route('**/api/project', async (route) => {
    if (!intercepted) {
      intercepted = true;
      const remote = await state(request);
      const other = clone(remote.project); other.name = 'Other tab edited';
      await post(request, 'project', { expectedRevision: remote.revision, project: other });
    }
    await route.continue();
  });
  await stroke(page, 7, 7);
  await expect(page.locator('#conflict-banner')).toBeVisible();
  const browserVersion = await currentProjectDownload(page);
  expect(browserVersion.frames[0].cels[browserVersion.layers[0].id][119]).toBe('#FFAF24FF');
  expect((await state(request)).project.name).toBe('Other tab edited');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#conflict-banner')).toBeVisible();
  const recovered = await currentProjectDownload(page);
  expect(sameProject(browserVersion, recovered)).toBeTruthy();
});

test('GitHub Pages subpath works without a bridge; offline proposal round trip and responsive layout', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#bridge-badge')).toHaveText('STATIC');
  await expect(page.locator('#project-name')).toHaveText('Golden helmet');
  await expect(page.locator('#layers .layer')).toHaveCount(3);
  await page.screenshot({ path: path.join('test-results', 'studio-desktop.png'), fullPage: true });
  const baseline = await currentProjectDownload(page);
  const candidate = applyOperations(baseline, [{ op: 'layer', name: 'Agent sparkle' }, { op: 'pixel', x: 14, y: 14, color: '#FFF052' }]);
  const envelope = { format: 'spritecanvas-proposal', version: 1, title: 'Offline sparkle', baseProject: baseline, project: candidate };
  await page.locator('#proposal-file').setInputFiles({ name: 'proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
  await expect(page.locator('#compare-dialog')).toBeVisible();
  await expect(page.locator('#diff-count')).toContainText('1 changed rendered pixel');
  await page.locator('#accept-button').click();
  expect(sameProject(await currentProjectDownload(page), candidate)).toBeTruthy();
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  expect(sameProject(await currentProjectDownload(page), candidate)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#overlay-canvas')).toBeVisible();
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport + 1);
  await page.screenshot({ path: path.join('test-results', 'studio-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('image import creates editable pixels, and GIF transparency does not trail across frames', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const image = createProject(4, 4);
  image.frames[0].cels[image.layers[0].id][0] = color('#FF0000');
  await page.locator('#open-file').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: encodePng(image) });
  await expect(page.locator('#image-dialog')).toBeVisible();
  await page.locator('#image-mode').selectOption('project');
  await page.locator('#image-form button[type="submit"]').click(); await saved(page);
  const imported = await currentProjectDownload(page);
  expect(imported.width).toBe(4);
  expect(imported.frames[0].cels[imported.layers[0].id][0]).toBe('#FF0000FF');
  const check = await page.evaluate(async () => {
    const { createProject, addFrame } = await import('./lib/model.js');
    const { encodeGif } = await import('./lib/gif.js');
    const p = createProject(32, 32);
    p.frames[0].cels[p.layers[0].id][0] = '#FF0000FF';
    addFrame(p); p.frames[1].cels[p.layers[0].id][33] = '#00FF00FF';
    const decoder = new ImageDecoder({ data: encodeGif(p), type: 'image/gif' });
    await decoder.tracks.ready;
    const output = await decoder.decode({ frameIndex: 1 });
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d'); context.drawImage(output.image, 0, 0);
    const result = { erased: [...context.getImageData(0, 0, 1, 1).data], green: [...context.getImageData(1, 1, 1, 1).data] };
    output.image.close(); decoder.close(); return result;
  });
  expect(check.erased[3]).toBe(0); expect(check.green).toEqual([0, 255, 0, 255]);
});

test('GIF decoder retains 255 exact artwork colors at scale and clears moving pixels without trails', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const project = createProject(16, 16, 'Exact GIF colors'), layer = project.layers[0].id;
  project.palette = ['#FF00FFFF'];
  for (let i = 0; i < 255; i++) project.frames[0].cels[layer][i] = fromRgba(i, i % 61, i % 43);
  addFrame(project);
  project.frames[1].cels[layer][255] = project.frames[0].cels[layer][0];
  project.frames[1].cels[layer][0] = project.frames[0].cels[layer][254];
  project.frames[1].duration = 235;
  addFrame(project);
  project.frames[2].duration = 20;
  const frames = await decodeGifFrames(page, project, 3);
  expect(frames).toHaveLength(3);
  for (let f = 0; f < frames.length; f++) {
    expect(frames[f].width).toBe(48); expect(frames[f].height).toBe(48);
    expect(frames[f].duration).toBe(Math.round(project.frames[f].duration / 10) * 10000);
    expect(frames[f].pixels).toEqual(expectedGifPixels(project, f, 3));
  }
});

test('GIF decoder preserves white-matte alpha semantics, empty frames, and single-color pixels', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const empty = createProject(1, 1), solid = createProject(1, 1);
  solid.frames[0].cels[solid.layers[0].id][0] = '#071119FF';
  const moving = createProject(6, 1), layer = moving.layers[0].id;
  moving.frames[0].cels[layer] = ['#1234567F', '#12345680', '#000000FF', '#203040C0', null, '#102030FF'];
  addLayer(moving, 'Glaze');
  moving.layers[1].opacity = 0.5;
  moving.frames[0].cels[moving.layers[1].id][5] = '#8899AA80';
  addFrame(moving);
  moving.frames[1].cels[layer][4] = '#12345680';
  moving.frames[1].duration = 25;
  addFrame(moving);
  moving.frames[2].duration = 10000;
  for (const project of [empty, solid, moving]) {
    const frames = await decodeGifFrames(page, project);
    expect(frames).toHaveLength(project.frames.length);
    for (let f = 0; f < frames.length; f++) {
      expect(frames[f].width).toBe(project.width); expect(frames[f].height).toBe(project.height);
      expect(frames[f].duration).toBe(Math.round(project.frames[f].duration / 10) * 10000);
      expect(frames[f].pixels).toEqual(expectedGifPixels(project, f));
    }
  }
});

test('GIF decoded dark-rich animation retains tonal fidelity and stable colors without dithering', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const project = createProject(64, 32, 'Dark RGB fidelity'), layer = project.layers[0].id;
  project.palette = [];
  for (let f = 0; f < 3; f++) {
    if (f) addFrame(project);
    const pixels = project.frames[f].cels[layer];
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      pixels[y * project.width + x] = x >= 56 && y < 8
        ? fromRgba(170 + x, 100 + y * 6, 30 + f * 8)
        : fromRgba(4 + x % 32, 8 + y, 6 + (x * 7 + y * 11 + f * 3) % 40);
    }
    pixels[0] = '#13212DFF';
    project.frames[f].duration = 90 + f * 70;
  }
  const frames = await decodeGifFrames(page, project, 2);
  const sourceColors = new Set(), darkColors = new Set(), errors = [], mapping = new Map();
  let stableMapping = true, opaque = true;
  expect(frames).toHaveLength(3);
  for (let f = 0; f < frames.length; f++) {
    const expected = expectedGifPixels(project, f, 2), decoded = frames[f].pixels;
    expect(frames[f].width).toBe(128); expect(frames[f].height).toBe(64);
    expect(frames[f].duration).toBe(project.frames[f].duration * 1000);
    for (let i = 0; i < expected.length; i += 4) {
      const source = expected.slice(i, i + 3), output = decoded.slice(i, i + 3);
      const key = source.join(','), value = output.join(',');
      sourceColors.add(key);
      if (mapping.has(key)) stableMapping &&= value === mapping.get(key);
      else mapping.set(key, value);
      if (Math.max(...source) < 64) darkColors.add(value);
      for (let c = 0; c < 3; c++) errors.push(Math.abs(source[c] - output[c]));
      opaque &&= decoded[i + 3] === 255;
    }
  }
  expect(stableMapping).toBeTruthy();
  expect(opaque).toBeTruthy();
  expect(sourceColors.size).toBeGreaterThan(1000);
  expect(darkColors.size).toBeGreaterThanOrEqual(180);
  const mae = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  errors.sort((a, b) => a - b);
  expect(mae).toBeLessThan(2.5);
  expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThanOrEqual(6);
});

test('new/resize, symmetry, secondary color, clipboard, transforms and layer rename', async ({ page, request }) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('.document-actions [data-action="new"]').click();
  await page.locator('#new-form input[name="name"]').fill('Symmetry study');
  await page.locator('#new-form input[name="width"]').fill('8');
  await page.locator('#new-form input[name="height"]').fill('8');
  await page.locator('#new-form button[type="submit"]').click(); await saved(page);
  await page.locator('#mirror-x').click();
  await hex(page, '#FFFFFF'); await stroke(page, 1, 1, 1, 1, 8); await saved(page);
  let doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id][9]).toBe('#FFFFFFFF');
  expect(doc.frames[0].cels[doc.layers[0].id][14]).toBe('#FFFFFFFF');
  await page.locator('#mirror-x').click();
  const secondaryPoint = await canvasPoint(page, 2, 1, 8);
  await page.mouse.click(secondaryPoint.x, secondaryPoint.y, { button: 'right' }); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id][10]).toBe('#11131DFF');
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
  await page.keyboard.press('Delete'); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id].filter(Boolean)).toHaveLength(0);
  await page.keyboard.press('Control+v'); await saved(page);
  await page.locator('[data-action="flip-x"]').click(); await saved(page);
  doc = (await state(request)).project;
  expect(doc.frames[0].cels[doc.layers[0].id][13]).toBe('#11131DFF');
  await page.locator('#layers .layer-name').dblclick();
  await expect(page.locator('#text-dialog')).toBeVisible();
  await page.locator('#text-input').fill('Symmetric ink'); await page.locator('#text-form button[type="submit"]').click();
  await page.locator('[data-action="resize"]').click();
  await page.locator('#resize-width').fill('10'); await page.locator('#resize-height').fill('10');
  await page.locator('#resize-form button[type="submit"]').click(); await saved(page);
  doc = (await state(request)).project;
  expect(doc.width).toBe(10); expect(doc.layers[0].name).toBe('Symmetric ink');
  expect(doc.frames[0].cels[doc.layers[0].id][26]).toBe('#11131DFF');
});

test('offline proposal imports reject wrong baselines without replacing artwork', async ({ page }) => {
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const baseline = await currentProjectDownload(page), wrongBase = clone(baseline);
  wrongBase.name = 'Unrelated drawing';
  const envelope = { format: 'spritecanvas-proposal', version: 1, title: 'Wrong base', baseProject: wrongBase, project: baseline };
  await page.locator('#proposal-file').setInputFiles({ name: 'wrong-proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
  await expect(page.locator('#notice')).toContainText('different or older canvas');
  await expect(page.locator('#compare-dialog')).not.toBeVisible();
  expect(sameProject(await currentProjectDownload(page), baseline)).toBeTruthy();
});

test('review feedback with reference reaches the agent CLI and updates the open review with its revision', async ({ page, request }, testInfo) => {
  await page.goto('/'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await stroke(page, 1, 1, 5, 1); await saved(page);
  const baseline = await state(request);
  const candidate = applyOperations(baseline.project, [{ op: 'pixel', x: 8, y: 8, color: '#FFFFFF' }]);
  await post(request, 'proposals', { expectedRevision: baseline.revision, project: candidate, title: 'Character on scribbles' });
  await expect(page.locator('#proposal-card')).toBeVisible();
  await page.locator('#compare-button').click();
  await page.locator('#request-changes-button').click();
  await page.locator('#feedback-message').fill('Clear all scribbles. Use a clean green background and match my attached reference.');
  const referenceBytes = encodePng(createProject(4, 4));
  await page.locator('#feedback-reference').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: referenceBytes });
  await expect(page.locator('#feedback-reference-preview')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('feedback-composer.png'), fullPage: true });
  await page.locator('#submit-feedback').click();
  await expect(page.locator('#compare-badge')).toHaveText('CHANGES REQUESTED');
  await expect(page.locator('#accept-button')).toBeDisabled();
  const reviewed = await state(request);
  expect(sameProject(reviewed.project, baseline.project)).toBeTruthy();
  expect(sameProject(reviewed.proposal.project, candidate)).toBeTruthy();
  expect(reviewed.revision).toBe(baseline.revision);
  const feedback = reviewed.feedback.at(-1);
  const output = testInfo.outputPath('review-files');
  const printed = await exec(process.execPath, ['scripts/agent.mjs', 'feedback', output, '--url', bridgeUrl]);
  const extracted = JSON.parse(printed.stdout).find((entry) => entry.id === feedback.id);
  expect(extracted.message).toContain('Clear all scribbles');
  expect(await readFile(extracted.reference.file)).toEqual(referenceBytes);
  const handoffPath = path.join(output, 'handoff.json');
  await exec(process.execPath, ['scripts/agent.mjs', 'pull', handoffPath, '--url', bridgeUrl]);
  const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
  expect(handoff.feedback.at(-1).id).toBe(feedback.id);
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('#compare-button').click();
  await expect(page.locator('#review-history')).toContainText('Clear all scribbles');
  const clean = clone(handoff.project);
  clean.frames[0].cels[clean.layers[0].id].fill('#008657FF');
  const file = path.join(output, 'clean.json');
  await writeFile(file, JSON.stringify(clean));
  await exec(process.execPath, ['scripts/agent.mjs', 'propose', file, '--base', String(handoff.revision), '--replace', handoff.proposal.id, '--respond-to', feedback.id, '--title', 'Clean revised composition', '--url', bridgeUrl]);
  await expect(page.locator('#compare-title')).toHaveText('Clean revised composition');
  await expect(page.locator('#compare-badge')).toHaveText('PROPOSAL');
  await expect(page.locator('#accept-button')).toBeEnabled();
  await expect(page.locator('#review-history')).toContainText('Addressed in this revision');
  expect(sameProject((await state(request)).project, baseline.project)).toBeTruthy();
  const pixel = await page.locator('#after-canvas').evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]);
  expect(pixel).toEqual([0, 134, 87, 255]);
  await page.locator('#accept-button').click();
  expect(sameProject((await state(request)).project, clean)).toBeTruthy();
});

test('static review request downloads its note and reference and accepts a matching revision', async ({ page }) => {
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const original = await currentProjectDownload(page);
  const candidate = applyOperations(original, [{ op: 'layer', name: 'First attempt' }, { op: 'pixel', x: 2, y: 2, color: '#FF0000' }]);
  const envelope = { format: 'spritecanvas-proposal', version: 1, title: 'First attempt', baseProject: original, project: candidate };
  await page.locator('#proposal-file').setInputFiles({ name: 'proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
  await page.locator('#request-changes-button').click();
  await page.locator('#feedback-message').fill('Remove the added red mark and keep the original composition.');
  await page.locator('#feedback-reference').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: encodePng(original) });
  await expect(page.locator('#feedback-reference-preview')).toBeVisible();
  const packetFile = await downloaded(page, () => page.locator('#submit-feedback').click());
  const packet = JSON.parse(packetFile.bytes);
  expect(packet.format).toBe('spritecanvas-handoff');
  expect(packet.feedback.at(-1).reference.dataUrl).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('#compare-badge')).toHaveText('CHANGES REQUESTED');
  await expect(page.locator('#accept-button')).toBeDisabled();
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('#compare-button').click();
  await expect(page.locator('#review-history')).toContainText('Remove the added red mark');
  await page.locator('#compare-dialog [data-close]').click();
  const revision = {
    format: 'spritecanvas-proposal', version: 1, title: 'Red mark removed',
    baseProject: packet.project, project: clone(packet.project),
    replacesProposalId: packet.proposal.id, respondsTo: packet.feedback.at(-1).id,
  };
  await page.locator('#proposal-file').setInputFiles({ name: 'revision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(revision)) });
  await expect(page.locator('#compare-title')).toHaveText('Red mark removed');
  await expect(page.locator('#compare-badge')).toHaveText('PROPOSAL');
  await expect(page.locator('#accept-button')).toBeEnabled();
  await page.locator('#accept-button').click();
  expect(sameProject(await currentProjectDownload(page), original)).toBeTruthy();
});

test('an incoming proposal revision does not silently discard an unsent feedback draft', async ({ page, request }) => {
  const baseline = await state(request);
  const pending = await post(request, 'proposals', { expectedRevision: baseline.revision, project: baseline.project, title: 'Original proposal' });
  const reviewed = await post(request, 'feedback', { expectedRevision: baseline.revision, proposalId: pending.proposal.id, message: 'First requested adjustment' });
  await page.goto('/?review=1'); await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('#request-changes-button').click();
  await page.locator('#feedback-message').fill('An unsent additional thought');
  await post(request, 'proposals', {
    expectedRevision: baseline.revision, project: baseline.project, title: 'New proposal',
    replacesProposalId: pending.proposal.id, respondsTo: reviewed.feedback.at(-1).id,
  });
  await expect(page.locator('#compare-badge')).toHaveText('SUPERSEDED');
  await expect(page.locator('#feedback-message')).toHaveValue('An unsent additional thought');
  await expect(page.locator('#latest-proposal-button')).toHaveText('Show latest (discard draft)');
  await expect(page.locator('#accept-button')).not.toBeVisible();
});
