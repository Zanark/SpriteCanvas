import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { composite } from '../../web/lib/model.js';
import { idleBrandAssets } from '../../scripts/brand-idle.mjs';

test('README idle GIF decodes all 16x waddle poses and moving warm flare under the Pages subpath', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/');
  const idle = JSON.parse(await readFile(path.join('web', 'assets', 'spritecanvas-logo-idle.spritecanvas.json'), 'utf8'));
  const { gifProject } = idleBrandAssets(idle);
  const decoded = await page.evaluate(async () => {
    const response = await fetch('./assets/spritecanvas-logo-idle.gif');
    if (!response.ok) throw new Error(`Idle GIF request failed: ${response.status}`);
    const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack, frames = [];
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
        const { image } = await decoder.decode({ frameIndex });
        try {
          const canvas = document.createElement('canvas');
          canvas.width = image.displayWidth; canvas.height = image.displayHeight;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let mismatches = 0;
          const nativeColors = [], coverage = [];
          for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
            let samples = 0, color = null;
            for (let dy = 0; dy < 16; dy++) for (let dx = 0; dx < 16; dx++) {
              const i = ((y * 16 + dy) * canvas.width + x * 16 + dx) * 4;
              if (pixels[i + 3] === 0) continue;
              if (pixels[i + 3] !== 255) mismatches++;
              samples++;
              if (color === null) color = [...pixels.subarray(i, i + 3)];
              for (let c = 0; c < 3; c++) if (pixels[i + c] !== color[c]) mismatches++;
            }
            nativeColors.push(...(color || [0, 0, 0])); coverage.push(samples);
          }
          frames.push({ width: canvas.width, height: canvas.height, duration: image.duration, mismatches, nativeColors, coverage,
            preview: canvas.toDataURL() });
        } finally { image.close(); }
      }
      return { loopsForever: track.repetitionCount === Infinity, frames };
    } finally { decoder.close(); }
  });
  expect(decoded.frames).toHaveLength(8); expect(decoded.loopsForever).toBe(true);
  expect(decoded.frames.reduce((sum, frame) => sum + frame.duration, 0)).toBe(880_000);
  for (let f = 0; f < decoded.frames.length; f++) {
    const frame = decoded.frames[f], expected = composite(gifProject, f);
    expect([frame.width, frame.height, frame.mismatches]).toEqual([512, 512, 0]);
    expect(frame.duration).toBe(idle.frames[f].duration * 1000);
    const opaqueErrors = [];
    let weightedError = 0, visibleSamples = 0;
    for (let i = 0; i < expected.length; i += 4) {
      const samples = frame.coverage[i / 4];
      expect(samples).toBe(Math.round(expected[i + 3] * 256 / 255));
      visibleSamples += samples;
      for (let c = 0; c < 3; c++) {
        const error = Math.abs(frame.nativeColors[i / 4 * 3 + c] - expected[i + c]);
        weightedError += error * samples;
        if (expected[i + 3] === 255) opaqueErrors.push(error);
      }
    }
    expect(visibleSamples).toBeLessThan(512 * 512 / 2);
    expect(weightedError / (visibleSamples * 3)).toBeLessThan(2.5);
    expect(opaqueErrors.sort((a, b) => a - b)[Math.floor(opaqueErrors.length * 0.95)]).toBeLessThanOrEqual(6);
    const flare = idle.frames[f].cels['camera-lens-flare'];
    const ray = flare.findIndex((pixel, i) => pixel && i % 32 === 0 && expected[i * 4] > 60);
    expect(ray).toBeGreaterThanOrEqual(0);
    expect(frame.coverage[ray]).toBeGreaterThan(0);
    expect(frame.nativeColors[ray * 3]).toBeGreaterThan(55);
  }
  expect(new Set(decoded.frames.map(frame => JSON.stringify([frame.nativeColors, frame.coverage]))).size).toBe(8);
  await page.route('**/idle-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body style="margin:16px;background:#1E2125;color:white;font:16px sans-serif">
      <div id="themes" style="display:flex;gap:16px">${['#FFFFFF', '#1E2125'].map((color, i) => `<div style="background:${color};color:${i ? 'white' : 'black'};padding:8px">
      <p>${i ? 'Dark page' : 'Light page'} - transparent GIF, actual 16x</p>
      <img src="${decoded.frames[0].preview}" width="512" height="512"></div>`).join('')}</div>
      <div id="poses" style="display:grid;grid-template-columns:repeat(4,256px);gap:8px">${decoded.frames.map((frame, f) => `<div><p>Pose ${f + 1} - ${f * 110}ms</p>
      <img src="${frame.preview}" width="256" height="256" style="image-rendering:pixelated"></div>`).join('')}</div></body>`,
  }));
  await page.setViewportSize({ width: 1120, height: 1300 });
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/idle-preview');
  await page.locator('#themes').screenshot({ path: path.join('test-results', 'readme-transparent-light-dark.png') });
  await page.locator('#poses').screenshot({ path: path.join('test-results', 'readme-idle-decoded.png') });
});
