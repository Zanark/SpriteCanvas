import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGif } from '../web/lib/gif.js';
import { createProject, addFrame, addLayer, clone, composite, fromRgba } from '../web/lib/model.js';

function inspectGif(data) {
  const word = (offset) => data[offset] | (data[offset + 1] << 8);
  assert.equal(Buffer.from(data.subarray(0, 6)).toString(), 'GIF89a');
  assert.equal(data[10], 0xF7);
  const palette = Array.from({ length: 256 }, (_, i) => [...data.subarray(13 + i * 3, 16 + i * 3)]);
  const frames = [], extensions = [];
  let offset = 781, control;
  const blocks = () => {
    const bytes = [];
    while (data[offset]) {
      const length = data[offset++];
      bytes.push(...data.subarray(offset, offset + length));
      offset += length;
    }
    offset++;
    return bytes;
  };
  while (data[offset] !== 0x3B) {
    const type = data[offset++];
    if (type === 0x21) {
      const label = data[offset++];
      if (label === 0xF9) {
        assert.equal(data[offset], 4);
        control = { disposal: (data[offset + 1] >> 2) & 7, transparent: data[offset + 1] & 1,
          delay: word(offset + 2), transparentIndex: data[offset + 4] };
        assert.equal(data[offset + 5], 0);
        offset += 6;
      } else {
        extensions.push({ label, data: blocks() });
      }
      continue;
    }
    assert.equal(type, 0x2C);
    const frame = { ...control, left: word(offset), top: word(offset + 2),
      width: word(offset + 4), height: word(offset + 6), flags: data[offset + 8] };
    assert.equal(frame.flags, 0, 'every frame uses the global palette');
    offset += 9;
    assert.equal(data[offset++], 8);
    const compressed = blocks(), pixels = [];
    // The encoder intentionally emits literal 9-bit codes with frequent clears.
    let buffer = 0, bits = 0, ended = false, clears = 0;
    for (const byte of compressed) {
      buffer |= byte << bits; bits += 8;
      if (bits < 9) continue;
      const code = buffer & 511; buffer >>>= 9; bits -= 9;
      if (code === 256) clears++;
      else if (code === 257) { ended = true; break; }
      else { assert.ok(code < 256); pixels.push(code); }
    }
    assert.ok(ended && clears > 0);
    assert.equal(pixels.length, frame.width * frame.height);
    frames.push({ ...frame, pixels });
  }
  assert.equal(offset, data.length - 1);
  return { width: word(6), height: word(8), palette, frames, extensions };
}

function expectedPixels(project, index) {
  const rgba = composite(project, index), pixels = [];
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    pixels.push(alpha < 0.5 ? [0, 0, 0, 0] :
      [0, 1, 2].map((c) => Math.round(rgba[i + c] * alpha + 255 * (1 - alpha))).concat(255));
  }
  return pixels;
}

function decodedPixels(gif, frame = 0) {
  return gif.frames[frame].pixels.map((index) => index === 0 ? [0, 0, 0, 0] : [...gif.palette[index], 255]);
}

function darkAnimation() {
  const project = createProject(64, 32, 'Dark RGB fidelity');
  project.palette = ['#FF00FFFF'];
  for (let frame = 0; frame < 3; frame++) {
    if (frame) addFrame(project);
    const pixels = project.frames[frame].cels[project.layers[0].id];
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      pixels[y * project.width + x] = x >= 56 && y < 8
        ? fromRgba(170 + x, 100 + y * 6, 30 + frame * 8)
        : fromRgba(4 + x % 32, 8 + y, 6 + (x * 7 + y * 11 + frame * 3) % 40);
    }
    pixels[0] = '#13212DFF';
    project.frames[frame].duration = 90 + frame * 70;
  }
  return project;
}

test('GIF retains exactly 255 composited RGB colors plus transparency, not the editing palette', () => {
  const project = createProject(16, 16);
  const pixels = project.frames[0].cels[project.layers[0].id];
  for (let i = 0; i < 255; i++) pixels[i] = fromRgba(i, i % 61, i % 43);
  addLayer(project, 'Hidden colors');
  project.layers[1].visible = false;
  project.frames[0].cels[project.layers[1].id].fill('#FF00FFFF');
  const before = clone(project), bytes = encodeGif(project);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(project, before);
  const gif = inspectGif(bytes);
  assert.deepEqual(decodedPixels(gif), expectedPixels(project, 0));
  assert.equal(new Set(gif.frames[0].pixels).size, 256);
  assert.notEqual(gif.frames[0].pixels[0], 0, 'opaque black is not transparency');
  project.palette = [];
  assert.deepEqual(encodeGif(project), bytes);
});

test('GIF uses a deterministic animation-wide palette and stable RGB indices even above 255 colors', () => {
  const project = darkAnimation(), bytes = encodeGif(project), gif = inspectGif(bytes);
  assert.deepEqual(encodeGif(clone(project)), bytes);
  for (const frame of gif.frames) assert.equal(frame.pixels[0], gif.frames[0].pixels[0]);
  project.frames.reverse();
  const reversed = inspectGif(encodeGif(project));
  assert.deepEqual(reversed.palette, gif.palette, 'frame ordering does not influence the histogram palette');
  assert.deepEqual(reversed.frames.map((frame) => frame.pixels), gif.frames.map((frame) => frame.pixels).reverse());
});

test('GIF adaptive quantization retains dark tonal diversity with low RGB error', () => {
  const project = darkAnimation(), gif = inspectGif(encodeGif(project));
  const errors = [], sourceColors = new Set(), darkColors = new Set();
  for (let f = 0; f < project.frames.length; f++) {
    const expected = expectedPixels(project, f), decoded = decodedPixels(gif, f);
    for (let i = 0; i < expected.length; i++) {
      sourceColors.add(expected[i].slice(0, 3).join(','));
      for (let c = 0; c < 3; c++) errors.push(Math.abs(expected[i][c] - decoded[i][c]));
      if (Math.max(...expected[i].slice(0, 3)) < 64) darkColors.add(decoded[i].slice(0, 3).join(','));
    }
  }
  assert.ok(sourceColors.size > 1000);
  assert.ok(darkColors.size >= 180, `only ${darkColors.size} dark colors survived`);
  const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
  errors.sort((a, b) => a - b);
  assert.ok(mae < 2.5, `RGB MAE ${mae}`);
  assert.ok(errors[Math.floor(errors.length * 0.95)] <= 6, '95th-percentile channel error exceeds 6');
});

test('GIF mattes partial alpha over white only after compositing visible layers', () => {
  const project = createProject(6, 1), layer = project.layers[0].id;
  project.frames[0].cels[layer] = ['#1234567F', '#12345680', '#000000FF', '#203040C0', null, '#102030FF'];
  addLayer(project, 'Glaze');
  project.layers[1].opacity = 0.5;
  project.frames[0].cels[project.layers[1].id][5] = '#8899AA80';
  const gif = inspectGif(encodeGif(project)), decoded = decodedPixels(gif);
  assert.deepEqual(decoded, expectedPixels(project, 0));
  assert.deepEqual(decoded[0], [0, 0, 0, 0]);
  assert.deepEqual(decoded[1], [136, 153, 170, 255]);
});

test('GIF scales indexed blocks without changing its palette, dimensions, timing, or loop/disposal metadata', () => {
  const project = darkAnimation(), native = inspectGif(encodeGif(project));
  const scaled = inspectGif(encodeGif(project, 3));
  assert.equal(scaled.width, project.width * 3);
  assert.equal(scaled.height, project.height * 3);
  assert.deepEqual(scaled.palette, native.palette);
  const loop = scaled.extensions.find((extension) => extension.label === 0xFF);
  assert.equal(Buffer.from(loop.data.slice(0, 11)).toString(), 'NETSCAPE2.0');
  assert.deepEqual(loop.data.slice(11), [1, 0, 0]);
  for (let f = 0; f < project.frames.length; f++) {
    const frame = scaled.frames[f];
    assert.equal(frame.delay, Math.max(2, Math.round(project.frames[f].duration / 10)));
    assert.equal(frame.disposal, 2);
    assert.equal(frame.transparent, 1);
    assert.equal(frame.transparentIndex, 0);
    assert.equal(frame.left, 0); assert.equal(frame.top, 0);
    assert.equal(frame.width, scaled.width); assert.equal(frame.height, scaled.height);
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      assert.equal(frame.pixels[y * frame.width + x],
        native.frames[f].pixels[Math.floor(y / 3) * project.width + Math.floor(x / 3)]);
    }
  }
});

test('GIF handles all-transparent and one-color 1x1 frames and rounds timing to centiseconds', () => {
  const project = createProject(1, 1);
  assert.deepEqual(decodedPixels(inspectGif(encodeGif(project))), [[0, 0, 0, 0]]);
  addFrame(project);
  project.frames[1].cels[project.layers[0].id][0] = '#071119FF';
  project.frames[0].duration = 24; project.frames[1].duration = 25;
  addFrame(project);
  project.frames[2].duration = 10000;
  const gif = inspectGif(encodeGif(project));
  assert.deepEqual(decodedPixels(gif, 0), [[0, 0, 0, 0]]);
  assert.deepEqual(decodedPixels(gif, 1), [[7, 17, 25, 255]]);
  assert.deepEqual(decodedPixels(gif, 2), [[0, 0, 0, 0]]);
  assert.deepEqual(gif.frames.map((frame) => frame.delay), [2, 3, 1000]);
});

test('GIF still supports the 16x export option for a 100x80 twelve-frame scene', () => {
  const project = createProject(100, 80);
  for (let i = 1; i < 12; i++) addFrame(project);
  const bytes = encodeGif(project, 16);
  assert.equal(bytes[6] | (bytes[7] << 8), 1600);
  assert.equal(bytes[8] | (bytes[9] << 8), 1280);
  assert.equal(bytes.at(-1), 0x3B);
});

test('GIF explicitly rejects invalid projects, scales, dimensions, and oversized exports', () => {
  const project = createProject(2, 2);
  for (const scale of [0, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => encodeGif(project, scale), /GIF scale/);
  }
  assert.throws(() => encodeGif({ ...project, width: 0 }), /Width/);
  assert.throws(() => encodeGif({ ...project, frames: [] }), /frames/);
  const invalid = clone(project); invalid.frames[0].duration = NaN;
  assert.throws(() => encodeGif(invalid), /Frame duration/);
  invalid.frames[0].duration = 120;
  invalid.frames[0].cels[invalid.layers[0].id].pop();
  assert.throws(() => encodeGif(invalid), /pixel count/);
  assert.throws(() => encodeGif(project, 32768), /GIF width/);
  assert.throws(() => encodeGif(project, 2829), /32 million/);
  assert.throws(() => encodeGif(project, 1, { alphaMode: 'unknown' }), /GIF alpha mode/);
});

test('optional alpha dithering preserves coverage and RGB without a background matte', () => {
  const project = createProject(8, 1), alpha = [0, 1, 32, 64, 127, 128, 192, 255];
  project.frames[0].cels[project.layers[0].id] = alpha.map(a => fromRgba(255, 246, 168, a));
  const before = clone(project), gif = inspectGif(encodeGif(project, 16, { alphaMode: 'dither' }));
  const pixels = decodedPixels(gif);
  assert.deepEqual(project, before);
  for (let cell = 0; cell < alpha.length; cell++) {
    let visible = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const pixel = pixels[y * gif.width + cell * 16 + x];
      if (pixel[3]) { visible++; assert.deepEqual(pixel, [255, 246, 168, 255]); }
    }
    assert.equal(visible, Math.round(alpha[cell] * 256 / 255), 'Each 16x block approximates its original alpha within half a sample.');
  }
  assert.equal(gif.frames[0].disposal, 2);
});

test('alpha dithering is deterministic and clears moving transparent frames without erasing opaque black', () => {
  const project = createProject(2, 1), layer = project.layers[0].id;
  project.frames[0].cels[layer] = ['#000000FF', '#FFF6A840'];
  addFrame(project, 0);
  project.frames[1].cels[layer] = ['#FFF6A840', null];
  const bytes = encodeGif(project, 16, { alphaMode: 'dither' });
  assert.deepEqual(encodeGif(clone(project), 16, { alphaMode: 'dither' }), bytes);
  const gif = inspectGif(bytes), first = decodedPixels(gif), second = decodedPixels(gif, 1);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    assert.deepEqual(first[y * 32 + x], [0, 0, 0, 255]);
    assert.equal(first[y * 32 + x + 16][3], second[y * 32 + x][3], 'The dither pattern does not flicker across frames or whole-native-pixel moves.');
    assert.equal(second[y * 32 + x + 16][3], 0);
  }
  assert.ok(gif.frames.every(frame => frame.disposal === 2 && frame.transparent === 1));
});
