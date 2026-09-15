import { composite, integer, validateProject } from './model.js';

const COLOR_WEIGHTS = [0.299, 0.587, 0.114];

// One palette for the entire animation, independent of the editor's swatches.
// Index 0 is transparent; alpha >= 0.5 is matted against white before quantizing.
export function encodeGif(project, scale = 1) {
  integer(scale, 1, 65535, 'GIF scale');
  project = validateProject(project);
  const width = project.width * scale, height = project.height * scale;
  integer(width, 1, 65535, 'GIF width');
  integer(height, 1, 65535, 'GIF height');
  if (width * height * project.frames.length > 32_000_000) {
    throw new Error('GIF export is too large. Reduce scale (maximum 32 million total frame pixels).');
  }
  const histogram = new Map();
  const frames = project.frames.map((_, index) => {
    const rgba = composite(project, index);
    const pixels = new Int32Array(project.width * project.height).fill(-1);
    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4, alpha = rgba[offset + 3] / 255;
      if (alpha < 0.5) continue;
      const r = Math.round(rgba[offset] * alpha + 255 * (1 - alpha));
      const g = Math.round(rgba[offset + 1] * alpha + 255 * (1 - alpha));
      const b = Math.round(rgba[offset + 2] * alpha + 255 * (1 - alpha));
      const rgb = (r << 16) | (g << 8) | b;
      pixels[i] = rgb;
      histogram.set(rgb, (histogram.get(rgb) || 0) + 1);
    }
    return pixels;
  });
  const palette = adaptivePalette(histogram);
  const indices = new Map();
  // Resolve each native RGB only once, never once per scaled output pixel.
  for (const rgb of histogram.keys()) indices.set(rgb, nearestColor(rgb, palette) + 1);
  const bytes = [];
  const byte = (value) => bytes.push(value & 255);
  const word = (value) => { byte(value); byte(value >> 8); };
  const ascii = (text) => { for (const c of text) byte(c.charCodeAt(0)); };
  const block = (data) => {
    for (let offset = 0; offset < data.length; offset += 255) {
      const part = data.slice(offset, offset + 255);
      byte(part.length);
      for (const value of part) byte(value);
    }
    byte(0);
  };
  ascii('GIF89a'); word(width); word(height); byte(0xF7); byte(0); byte(0);
  byte(0); byte(0); byte(0);
  for (const rgb of palette) {
    byte(rgb[0]); byte(rgb[1]); byte(rgb[2]);
  }
  for (let i = palette.length + 1; i < 256; i++) { byte(0); byte(0); byte(0); }
  byte(0x21); byte(0xFF); byte(11); ascii('NETSCAPE2.0');
  byte(3); byte(1); word(0); byte(0);
  for (let index = 0; index < project.frames.length; index++) {
    byte(0x21); byte(0xF9); byte(4); byte(9);
    word(Math.max(2, Math.round(project.frames[index].duration / 10))); byte(0); byte(0);
    byte(0x2C); word(0); word(0); word(width); word(height); byte(0);
    byte(8);
    const native = Uint8Array.from(frames[index], (rgb) => rgb === -1 ? 0 : indices.get(rgb));
    block(lzw(scaleIndices(native, project.width, project.height, scale)));
  }
  byte(0x3B);
  return new Uint8Array(bytes);
}

function adaptivePalette(histogram) {
  const colors = [...histogram].sort(([a], [b]) => a - b).map(([key, count]) => ({
    rgb: [key >> 16, (key >> 8) & 255, key & 255], count,
  }));
  if (colors.length <= 255) return colors.map((color) => color.rgb);
  const boxes = [colorBox(colors)];
  while (boxes.length < 255) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].gain > 0 && (best === -1 || boxes[i].gain > boxes[best].gain)) best = i;
    }
    if (best === -1) break;
    const box = boxes[best], left = [], right = [];
    for (const color of box.colors) {
      (color.rgb[box.axis] <= box.cut ? left : right).push(color);
    }
    boxes[best] = colorBox(left);
    boxes.push(colorBox(right));
  }
  return boxes.map((box) => box.sum.map((value) => Math.round(value / box.count)));
}

function colorBox(colors) {
  const sum = [0, 0, 0];
  let count = 0;
  // Exact 8-bit channel marginals make every axis/cut inexpensive to evaluate.
  const bins = Array.from({ length: 3 }, () => new Float64Array(256 * 4));
  for (const color of colors) {
    count += color.count;
    const weighted = color.rgb.map((value, c) => {
      const weight = value * color.count;
      sum[c] += weight;
      return weight;
    });
    for (let axis = 0; axis < 3; axis++) {
      const offset = color.rgb[axis] * 4, bin = bins[axis];
      bin[offset] += color.count;
      for (let c = 0; c < 3; c++) bin[offset + c + 1] += weighted[c];
    }
  }
  const box = { colors, count, sum, gain: 0, axis: 0, cut: 0 };
  if (colors.length < 2) return box;
  // Maximize the reduction in frequency-weighted, perceptual RGB squared error.
  // Squared-sample terms cancel, leaving only counts and channel sums.
  const score = (values, weight) => values.reduce((total, value, c) =>
    total + COLOR_WEIGHTS[c] * value * value / weight, 0);
  const base = score(sum, count);
  for (let axis = 0; axis < 3; axis++) {
    const left = [0, 0, 0], right = [...sum], bin = bins[axis];
    let leftCount = 0;
    for (let cut = 0; cut < 255; cut++) {
      const offset = cut * 4;
      leftCount += bin[offset];
      for (let c = 0; c < 3; c++) {
        left[c] += bin[offset + c + 1];
        right[c] -= bin[offset + c + 1];
      }
      if (!leftCount || leftCount === count) continue;
      const gain = score(left, leftCount) + score(right, count - leftCount) - base;
      if (gain > box.gain) { box.gain = gain; box.axis = axis; box.cut = cut; }
    }
  }
  return box;
}

function nearestColor(key, palette) {
  const r = key >> 16, g = (key >> 8) & 255, b = key & 255;
  let nearest = 0, distance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const rgb = palette[i];
    const error = COLOR_WEIGHTS[0] * (r - rgb[0]) ** 2 +
      COLOR_WEIGHTS[1] * (g - rgb[1]) ** 2 + COLOR_WEIGHTS[2] * (b - rgb[2]) ** 2;
    if (error < distance) { distance = error; nearest = i; }
    if (error === 0) break;
  }
  return nearest;
}

function scaleIndices(native, width, height, scale) {
  if (scale === 1) return native;
  const stride = width * scale, indexed = new Uint8Array(stride * height * scale);
  for (let y = 0; y < height; y++) {
    const start = y * scale * stride;
    for (let x = 0; x < width; x++) {
      indexed.fill(native[y * width + x], start + x * scale, start + (x + 1) * scale);
    }
    for (let repeat = 1; repeat < scale; repeat++) {
      indexed.copyWithin(start + repeat * stride, start, start + stride);
    }
  }
  return indexed;
}

function lzw(pixels) {
  // Clear before 9-bit codes overflow. This trades compression for a small,
  // predictable encoder and remains valid for arbitrary-length frame data.
  const output = [];
  let buffer = 0, bits = 0;
  const emit = (code) => {
    buffer |= code << bits;
    bits += 9;
    while (bits >= 8) { output.push(buffer & 255); buffer >>>= 8; bits -= 8; }
  };
  for (let start = 0; start < pixels.length; start += 250) {
    emit(256);
    for (let i = start; i < Math.min(start + 250, pixels.length); i++) emit(pixels[i]);
  }
  emit(257);
  if (bits) output.push(buffer & 255);
  return output;
}
