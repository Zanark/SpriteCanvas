import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { brandAssets } from '../scripts/brand.mjs';
import { composite, createProject, validateProject, rgba } from '../web/lib/model.js';

const file = name => new URL(`../web/${name}`, import.meta.url);
const source = validateProject(JSON.parse(await readFile(file('assets/spritecanvas-logo.spritecanvas.json'), 'utf8')));

test('character logo remains transparent, layered, and anatomically consistent', () => {
  assert.equal(source.width, 32);
  assert.equal(source.height, 32);
  assert.equal(source.frames.length, 1);
  assert.equal(source.layers.length, 6);
  assert.equal(source.palette.length, 10);
  assert.ok(source.layers.every(layer => !layer.locked && layer.visible && layer.opacity === 1));
  const { 'scout-boots': boots, 'scout-eyes': eyes, 'scout-earpiece': ear } = source.frames[0].cels;
  for (let y = 0; y < 3; y++) {
    assert.deepEqual(boots.slice((22 + y) * 32 + 8, (22 + y) * 32 + 16),
      boots.slice((22 + y) * 32 + 16, (22 + y) * 32 + 24), 'The front-facing boots are equal and level, not reposed.');
  }
  const ink = '#030604FF';
  for (const left of [13, 17]) for (let y = 18; y <= 19; y++) for (let x = left; x < left + 2; x++) {
    assert.equal(eyes[y * 32 + x], ink);
  }
  const eyeSymbols = { '#FFF3E7FF': 'W', '#B8BCB9FF': 'G', [ink]: '.' };
  assert.deepEqual([18, 19, 20].map(y => eyes.slice(y * 32 + 11, y * 32 + 21).map(pixel => eyeSymbols[pixel]).join('')),
    ['WW..WW..WW', 'GW..WW..WG', '.GGG..GGG.']);
  assert.equal(ear.filter(Boolean).length, 4);
  assert.ok(ear.filter(Boolean).every(pixel => pixel === '#243454FF'));
  const { faviconProject } = brandAssets(source);
  assert.equal(faviconProject.width, 20); assert.equal(faviconProject.height, 20);
  assert.ok(!faviconProject.layers.some(layer => layer.id === 'camera-lens-flare'));
  validateProject(faviconProject);
  for (const layer of faviconProject.layers) for (let y = 0; y < 20; y++) {
    assert.deepEqual(faviconProject.frames[0].cels[layer.id].slice(y * 20, (y + 1) * 20),
      source.frames[0].cels[layer.id].slice((y + 7) * 32 + 6, (y + 7) * 32 + 26),
      'The favicon crops unchanged character and lamp pixels, rather than reposing or repainting.');
  }
  const pixels = composite(faviconProject);
  let transparent = 0, opaque = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const alpha = pixels[(y * 20 + x) * 4 + 3];
    if (!alpha) transparent++; else opaque++;
    if (x === 0 || y === 0 || x === 19 || y === 19) assert.equal(alpha, 0, 'No flare or background around the favicon.');
  }
  assert.ok(transparent > 100 && opaque > 150);
  assert.equal(eyes[18 * 32 + 13], ink, 'The dark pupil is artwork, not erased background.');
  const flare = source.frames[0].cels['camera-lens-flare'];
  assert.ok(flare.filter(Boolean).length > 100);
  for (const pixel of flare.filter(Boolean)) {
    const [r, g, b, a] = rgba(pixel);
    assert.ok(r >= g && g >= b && a > 0, 'Keep the actual warm headlamp flare.');
  }
});

test('shipped logo SVG, PNG and favicon are reproducible from the editable source', async () => {
  const { svg, png, faviconSvg } = brandAssets(source);
  assert.equal((await readFile(file('assets/spritecanvas-logo.svg'), 'utf8')).replace(/\r\n/g, '\n'), svg);
  assert.equal((await readFile(file('favicon.svg'), 'utf8')).replace(/\r\n/g, '\n'), faviconSvg);
  assert.notEqual(svg, faviconSvg, 'Only the favicon omits the flare.');
  assert.deepEqual(await readFile(file('assets/spritecanvas-logo.png')), png);
  assert.equal(png.readUInt32BE(16), source.width * 32);
  assert.equal(png.readUInt32BE(20), source.height * 32);
  assert.doesNotMatch(svg, /<image|data:|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
});

test('static PNG contains exact 32 by 32 nearest-neighbor blocks, including flare alpha', async () => {
  const png = await readFile(file('assets/spritecanvas-logo.png')), chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks)), pixels = composite(source);
  const width = source.width * 32, stride = width * 4 + 1;
  assert.equal(rows.length, stride * source.height * 32);
  for (let y = 0; y < source.height; y++) {
    const expected = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const origin = (y * source.width + Math.floor(x / 32)) * 4;
      expected.set(pixels.subarray(origin, origin + 4), 1 + x * 4);
    }
    for (let repeat = 0; repeat < 32; repeat++) {
      const offset = (y * 32 + repeat) * stride;
      assert.deepEqual(rows.subarray(offset, offset + stride), expected);
    }
  }
});

test('logo pixels match the recorded camera-frame extraction without reposing', async () => {
  const provenance = JSON.parse(await readFile(file('assets/spritecanvas-logo-provenance.json'), 'utf8'));
  assert.equal(provenance.sourceGif, 'finished-character-candidate.gif');
  assert.equal(provenance.sourceFrameIndex, 7);
  assert.equal(provenance.sourceFrameId, 'lookaround-8');
  for (const layer of source.layers) {
    const hash = createHash('sha256').update(JSON.stringify(source.frames[0].cels[layer.id])).digest('hex');
    assert.equal(hash, provenance.layerHashes[layer.id]);
  }
});

test('brand generation requires an actually visible flare and character', () => {
  for (const state of ['missing', 'hidden', 'empty', 'transparent', 'zero-opacity']) {
    const invalid = structuredClone(source), layer = invalid.layers.find(layer => layer.id === 'camera-lens-flare');
    if (state === 'missing') invalid.layers = invalid.layers.filter(item => item !== layer);
    if (state === 'hidden') layer.visible = false;
    if (state === 'empty') invalid.frames[0].cels[layer.id].fill(null);
    if (state === 'transparent') invalid.frames[0].cels[layer.id].fill('#FFF6A800');
    if (state === 'zero-opacity') layer.opacity = 0;
    assert.throws(() => brandAssets(invalid), /visible camera-lens-flare/, state);
  }
  const noCharacter = structuredClone(source);
  noCharacter.layers.forEach(layer => { layer.visible = layer.id === 'camera-lens-flare'; });
  assert.throws(() => brandAssets(noCharacter), /visible character pixels/);
});

test('brand generation rejects non-square or animated logo sources', () => {
  assert.throws(() => brandAssets(createProject(2, 3)), /square, single-frame/);
  const animated = structuredClone(source);
  animated.frames.push({ ...structuredClone(animated.frames[0]), id: 'second-logo-frame' });
  assert.throws(() => brandAssets(animated), /square, single-frame/);
});
