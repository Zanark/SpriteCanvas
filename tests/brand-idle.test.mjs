import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { idleBrandAssets } from '../scripts/brand-idle.mjs';
import { composite, validateProject, rgba } from '../web/lib/model.js';

const read = async name => JSON.parse(await readFile(new URL(`../web/assets/${name}`, import.meta.url), 'utf8'));
const source = validateProject(await read('spritecanvas-logo.spritecanvas.json'));
const idle = validateProject(await read('spritecanvas-logo-idle.spritecanvas.json'));

test('waddle uses eight reference-timed poses while preserving scout anatomy and paired boot views', async () => {
  assert.equal(idle.width, 32); assert.equal(idle.height, 32);
  assert.equal(idle.frames.length, 8); assert.equal(idle.layers.length, 8);
  assert.deepEqual(idle.layers.slice(2), source.layers);
  assert.deepEqual(idle.palette, source.palette);
  assert.equal(idle.frames.reduce((sum, frame) => sum + frame.duration, 0), 880);
  assert.ok(idle.frames.every(frame => frame.duration === 110));
  const provenance = await read('spritecanvas-logo-idle-provenance.json');
  assert.equal(provenance.motionReference.frames, 8); assert.equal(provenance.motionReference.frameDurationMs, 110);
  assert.deepEqual(provenance.bootViews.flat, Array.from({ length: 3 }, (_, row) =>
    source.frames[0].cels['scout-boots'].slice((22 + row) * 32 + 8, (22 + row) * 32 + 16)));
  assert.equal(provenance.bootViews.sole.length, 5);
  assert.ok(provenance.bootViews.sole.every(row => row.length === 8 && row.every(pixel => !pixel || source.palette.includes(pixel))));
  const rounded = value => Math.sign(value) * Math.round(Math.abs(value));
  for (let f = 0; f < idle.frames.length; f++) {
    const frame = idle.frames[f], pose = provenance.poses[f];
    for (const id of ['scout-head', 'scout-eyes', 'scout-earpiece', 'scout-lamp']) {
      const expected = Array(1024).fill(null);
      source.frames[0].cels[id].forEach((pixel, i) => {
        if (!pixel) return;
        const x = i % 32, y = Math.floor(i / 32);
        const dx = pose.dx + rounded(pose.lean * (22 - y) / 10);
        expected[(y + pose.dy) * 32 + x + dx] = pixel;
      });
      assert.deepEqual(frame.cels[id], expected, 'Keep original component pixels; move the helmet assembly coherently.');
    }
    const boots = Array(1024).fill(null);
    for (const [x, y, view] of [pose.left, pose.right]) {
      provenance.bootViews[view].forEach((row, dy) => row.forEach((pixel, dx) => {
        if (pixel) boots[(y + dy) * 32 + x + dx] = pixel;
      }));
    }
    assert.deepEqual(frame.cels['scout-boots'], boots, 'Both feet use the same flat or forward-sole template, not differently sized shoes.');
    assert.equal(pose.left[2], f < 4 ? 'flat' : 'sole');
    assert.equal(pose.right[2], f < 4 ? 'sole' : 'flat');
    const support = f < 4 ? pose.left : pose.right;
    assert.equal(support[1] + provenance.bootViews.flat.length - 1, 25, 'The planted boot keeps a fixed ground line.');
    for (const left of [13, 17]) for (let y = 18; y < 20; y++) for (let x = left; x < left + 2; x++) {
      assert.equal(frame.cels['scout-eyes'][(y + pose.dy) * 32 + x + pose.dx], '#030604FF', 'Open pupils stay 2x2.');
    }
    assert.ok(frame.cels['scout-legs'].some(Boolean));
    assert.ok(frame.cels['scout-ground-shadow'].some(pixel => pixel && rgba(pixel)[3] > 0));
    const lampDx = pose.dx + pose.lean;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const sx = x - lampDx, sy = y - pose.dy, pixel = frame.cels['camera-lens-flare'][y * 32 + x];
      if (sx >= 0 && sx < 32 && sy >= 0 && sy < 32) {
        assert.equal(pixel, source.frames[0].cels['camera-lens-flare'][sy * 32 + sx], 'The original flare follows the lamp without RGB or alpha changes.');
      }
      if (pixel) {
        const [r, g, b] = rgba(pixel); assert.ok(r >= g && g >= b);
      }
    }
    assert.equal(createHash('sha256').update(JSON.stringify(frame.cels)).digest('hex'), provenance.frameHashes[frame.id]);
  }
  assert.equal(new Set(idle.frames.map(frame => JSON.stringify(frame.cels['scout-boots']))).size, 8, 'This must animate the poses, not just blink or pulse light.');
  assert.equal(Math.max(...provenance.poses.map(pose => pose.dy)) - Math.min(...provenance.poses.map(pose => pose.dy)), 2);
});

test('README uses a reproducible 16x looping GIF while editable artwork stays transparent', async () => {
  const before = structuredClone(idle), { gif, gifProject } = idleBrandAssets(idle);
  assert.deepEqual(idle, before);
  assert.deepEqual(await readFile(new URL('../web/assets/spritecanvas-logo-idle.gif', import.meta.url)), Buffer.from(gif));
  assert.equal(Buffer.from(gif.subarray(0, 6)).toString(), 'GIF89a');
  assert.equal(gif[6] | gif[7] << 8, 512); assert.equal(gif[8] | gif[9] << 8, 512);
  const loop = Buffer.from(gif).indexOf('NETSCAPE2.0');
  assert.ok(loop > 0);
  assert.deepEqual([...gif.subarray(loop + 11, loop + 16)], [3, 1, 0, 0, 0]);
  const transparentAlpha = composite(idle).findIndex((value, index) => index % 4 === 3 && value === 0);
  assert.ok(transparentAlpha >= 0);
  assert.deepEqual(gifProject, idle, 'No background or matte layer is added for export.');
  assert.equal(composite(gifProject)[transparentAlpha], 0);
  const provenance = await read('spritecanvas-logo-idle-provenance.json');
  assert.deepEqual(provenance.gifTransparency, { mode: 'ordered-alpha-dither', matrixSize: 16, matte: null });
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /<img src="web\/assets\/spritecanvas-logo-idle\.gif" width="512" height="512"/);
  assert.throws(() => idleBrandAssets(source), /square, animated/);
});
