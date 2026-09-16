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
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const origin = (Math.floor(y / 16) * 16 * canvas.width + Math.floor(x / 16) * 16) * 4;
            for (let c = 0; c < 4; c++) if (pixels[i + c] !== pixels[origin + c]) mismatches++;
          }
          const native = [];
          for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
            const i = (y * 16 * canvas.width + x * 16) * 4;
            native.push(...pixels.subarray(i, i + 4));
          }
          frames.push({ width: canvas.width, height: canvas.height, duration: image.duration, mismatches, native,
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
    const errors = [];
    for (let i = 0; i < expected.length; i += 4) {
      expect(frame.native[i + 3]).toBe(255);
      for (let c = 0; c < 3; c++) errors.push(Math.abs(frame.native[i + c] - expected[i + c]));
    }
    expect(errors.reduce((sum, value) => sum + value, 0) / errors.length).toBeLessThan(2.5);
    expect(errors.sort((a, b) => a - b)[Math.floor(errors.length * 0.95)]).toBeLessThanOrEqual(6);
    const flare = idle.frames[f].cels['camera-lens-flare'];
    const ray = flare.findIndex((pixel, i) => pixel && i % 32 === 0 && expected[i * 4] > 60);
    expect(ray).toBeGreaterThanOrEqual(0);
    expect(frame.native[ray * 4]).toBeGreaterThan(55);
  }
  expect(new Set(decoded.frames.map(frame => JSON.stringify(frame.native))).size).toBe(8);
  await page.route('**/idle-preview', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body style="margin:16px;background:#1E2125;color:white;font:16px sans-serif">
      <div style="display:grid;grid-template-columns:repeat(4,256px);gap:8px">${decoded.frames.map((frame, f) => `<div><p>Pose ${f + 1} - ${f * 110}ms</p>
      <img src="${frame.preview}" width="256" height="256" style="image-rendering:pixelated"></div>`).join('')}</div></body>`,
  }));
  await page.setViewportSize({ width: 1080, height: 650 });
  await page.goto('http://127.0.0.1:4274/SpriteCanvas/idle-preview');
  await page.screenshot({ path: path.join('test-results', 'readme-idle-decoded.png') });
});
