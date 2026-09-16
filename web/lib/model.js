export const FORMAT = 'spritecanvas';
export const LIMITS = { size: 256, layers: 24, frames: 64, cells: 2_000_000 };
export const DEFAULT_PALETTE = [
  '#11131D', '#FFFFFF', '#B8C0D0', '#555A73', '#243B65', '#448DE7',
  '#70D6FF', '#008657', '#41C691', '#C2F078', '#FFE65B', '#FFAF24',
  '#D97543', '#8E483F', '#F27D9A', '#AA79E6',
];

export const clone = (value) => structuredClone(value);
export const uid = () => globalThis.crypto.randomUUID();
export function color(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(value)) {
    throw new Error(`Invalid pixel color: ${String(value).slice(0, 32)}`);
  }
  const result = value.toUpperCase() + (value.length === 7 ? 'FF' : '');
  return result.endsWith('00') ? null : result;
}
export function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be non-empty text, at most ${max} characters.`);
  }
  return value;
}
export function createProject(width = 32, height = 32, name = 'Untitled sprite') {
  integer(width, 1, LIMITS.size, 'Width');
  integer(height, 1, LIMITS.size, 'Height');
  const layer = { id: uid(), name: 'Ink', visible: true, locked: false, opacity: 1 };
  return {
    format: FORMAT, version: 1, id: uid(), name, width, height,
    palette: DEFAULT_PALETTE.map(color),
    layers: [layer],
    frames: [{ id: uid(), duration: 120, cels: { [layer.id]: Array(width * height).fill(null) } }],
  };
}
export function validateProject(input) {
  if (!input || input.format !== FORMAT || input.version !== 1) throw new Error('Not a SpriteCanvas v1 project.');
  const width = integer(input.width, 1, LIMITS.size, 'Width');
  const height = integer(input.height, 1, LIMITS.size, 'Height');
  if (!Array.isArray(input.layers) || !input.layers.length || input.layers.length > LIMITS.layers) {
    throw new Error(`A project needs 1-${LIMITS.layers} layers.`);
  }
  if (!Array.isArray(input.frames) || !input.frames.length || input.frames.length > LIMITS.frames) {
    throw new Error(`A project needs 1-${LIMITS.frames} frames.`);
  }
  if (width * height * input.layers.length * input.frames.length > LIMITS.cells) {
    throw new Error('Project is too large (maximum two million editable pixels across all cels).');
  }
  const layerIds = new Set();
  const layers = input.layers.map((layer) => {
    const id = text(layer.id, 'Layer ID', 80);
    if (!/^[\w-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || layerIds.has(id)) {
      throw new Error('Layer IDs must be unique safe identifiers.');
    }
    layerIds.add(id);
    if (typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' ||
        !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      throw new Error('Invalid layer visibility, lock, or opacity.');
    }
    return { id, name: text(layer.name, 'Layer name'), visible: layer.visible, locked: layer.locked, opacity: layer.opacity };
  });
  const frameIds = new Set();
  const frames = input.frames.map((frame) => {
    const id = text(frame.id, 'Frame ID', 80);
    if (frameIds.has(id)) throw new Error('Frame IDs must be unique.');
    frameIds.add(id);
    const cels = {};
    for (const layer of layers) {
      const pixels = frame.cels?.[layer.id];
      if (!Array.isArray(pixels) || pixels.length !== width * height) throw new Error('A cel has the wrong pixel count.');
      cels[layer.id] = pixels.map(color);
    }
    return { id, duration: integer(frame.duration, 20, 10000, 'Frame duration'), cels };
  });
  if (!Array.isArray(input.palette) || input.palette.length > 256) throw new Error('Palette must contain at most 256 colors.');
  return {
    format: FORMAT, version: 1, id: text(input.id, 'Project ID', 80),
    name: text(input.name, 'Project name'), width, height,
    palette: [...new Set(input.palette.map(color).filter(Boolean))], layers, frames,
  };
}
export function sameProject(a, b) {
  return JSON.stringify(validateProject(a)) === JSON.stringify(validateProject(b));
}
export function rgba(value) {
  if (!value) return [0, 0, 0, 0];
  return [1, 3, 5, 7].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}
export function fromRgba(r, g, b, a = 255) {
  if (!a) return null;
  return '#' + [r, g, b, a].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function composite(project, frameIndex = 0) {
  const result = new Uint8ClampedArray(project.width * project.height * 4);
  const frame = project.frames[frameIndex];
  for (const layer of project.layers) {
    if (!layer.visible || !layer.opacity) continue;
    const pixels = frame.cels[layer.id];
    for (let i = 0; i < pixels.length; i++) {
      if (!pixels[i]) continue;
      const source = rgba(pixels[i]);
      const j = i * 4;
      const sa = source[3] / 255 * layer.opacity;
      const da = result[j + 3] / 255;
      const alpha = sa + da * (1 - sa);
      if (!alpha) continue;
      for (let c = 0; c < 3; c++) result[j + c] = (source[c] * sa + result[j + c] * da * (1 - sa)) / alpha;
      result[j + 3] = alpha * 255;
    }
  }
  return result;
}
export function difference(a, b, frameIndex = 0) {
  const left = composite(a, Math.min(frameIndex, a.frames.length - 1));
  const right = composite(b, Math.min(frameIndex, b.frames.length - 1));
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
  const pixels = new Uint8ClampedArray(width * height * 4);
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const l = x < a.width && y < a.height ? left.subarray((y * a.width + x) * 4, (y * a.width + x) * 4 + 4) : [0, 0, 0, 0];
    const r = x < b.width && y < b.height ? right.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4) : [0, 0, 0, 0];
    if (l.some((v, c) => v !== r[c])) {
      count++;
      pixels.set([190, 246, 104, 255], (y * width + x) * 4);
    } else {
      pixels.set([r[0], r[1], r[2], Math.round(r[3] * 0.22)], (y * width + x) * 4);
    }
  }
  return { pixels, width, height, count };
}
export function linePoints(x0, y0, x1, y1) {
  const result = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    result.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
  return result;
}
export function shapePoints(tool, x0, y0, x1, y1, filled = false) {
  if (tool === 'line') return linePoints(x0, y0, x1, y1);
  const points = [];
  const left = Math.min(x0, x1), right = Math.max(x0, x1);
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const rx = (right - left + 1) / 2, ry = (bottom - top + 1) / 2;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    if (tool === 'rect') {
      if (filled || x === left || x === right || y === top || y === bottom) points.push([x, y]);
    } else if (inside(x, y) && (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1))) {
      points.push([x, y]);
    }
  }
  return points;
}
export function inSelection(x, y, selection) {
  return !selection || (x >= selection.x && y >= selection.y && x < selection.x + selection.w && y < selection.y + selection.h);
}
export function paint(pixels, width, height, points, value, { size = 1, mirrorX = false, mirrorY = false, selection = null } = {}) {
  const offset = Math.floor(size / 2);
  for (const [px, py] of points) for (let by = 0; by < size; by++) for (let bx = 0; bx < size; bx++) {
    const x = px + bx - offset, y = py + by - offset;
    const xs = mirrorX ? [x, width - 1 - x] : [x];
    const ys = mirrorY ? [y, height - 1 - y] : [y];
    for (const tx of xs) for (const ty of ys) {
      if (tx >= 0 && ty >= 0 && tx < width && ty < height && inSelection(tx, ty, selection)) pixels[ty * width + tx] = value;
    }
  }
}
export function floodFill(pixels, width, height, x, y, value, selection = null) {
  if (x < 0 || y < 0 || x >= width || y >= height || !inSelection(x, y, selection)) return;
  const target = pixels[y * width + x];
  if (target === value) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (px < 0 || py < 0 || px >= width || py >= height || !inSelection(px, py, selection)) continue;
    const index = py * width + px;
    if (pixels[index] !== target) continue;
    pixels[index] = value;
    stack.push([px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]);
  }
}
export function addLayer(project, name = 'New layer') {
  if (project.layers.length >= LIMITS.layers) throw new Error(`Maximum ${LIMITS.layers} layers.`);
  if (project.width * project.height * (project.layers.length + 1) * project.frames.length > LIMITS.cells) throw new Error('Project pixel limit reached.');
  const layer = { id: uid(), name, visible: true, locked: false, opacity: 1 };
  project.layers.push(layer);
  for (const frame of project.frames) frame.cels[layer.id] = Array(project.width * project.height).fill(null);
  return layer;
}
export function addFrame(project, sourceIndex = null) {
  if (project.frames.length >= LIMITS.frames) throw new Error(`Maximum ${LIMITS.frames} frames.`);
  if (project.width * project.height * project.layers.length * (project.frames.length + 1) > LIMITS.cells) throw new Error('Project pixel limit reached.');
  const frame = { id: uid(), duration: 120, cels: {} };
  for (const layer of project.layers) frame.cels[layer.id] = sourceIndex === null
    ? Array(project.width * project.height).fill(null) : [...project.frames[sourceIndex].cels[layer.id]];
  if (sourceIndex !== null) frame.duration = project.frames[sourceIndex].duration;
  project.frames.splice(sourceIndex === null ? project.frames.length : sourceIndex + 1, 0, frame);
  return frame;
}
export function resizeProject(project, width, height, center = true) {
  integer(width, 1, LIMITS.size, 'Width');
  integer(height, 1, LIMITS.size, 'Height');
  if (width * height * project.layers.length * project.frames.length > LIMITS.cells) throw new Error('Project pixel limit reached.');
  const dx = center ? Math.floor((width - project.width) / 2) : 0;
  const dy = center ? Math.floor((height - project.height) / 2) : 0;
  for (const frame of project.frames) for (const layer of project.layers) {
    const old = frame.cels[layer.id], pixels = Array(width * height).fill(null);
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) pixels[(y + dy) * width + x + dx] = old[y * project.width + x];
    }
    frame.cels[layer.id] = pixels;
  }
  project.width = width; project.height = height;
}
export function transformCel(pixels, width, height, operation, selection = null) {
  const area = selection || { x: 0, y: 0, w: width, h: height };
  if (operation === 'rotate' && area.w !== area.h) throw new Error('90-degree rotation requires a square canvas or square selection.');
  const source = [...pixels];
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) {
    const sx = operation === 'flip-x' ? area.w - 1 - x : operation === 'rotate' ? y : x;
    const sy = operation === 'flip-y' ? area.h - 1 - y : operation === 'rotate' ? area.h - 1 - x : y;
    pixels[(area.y + y) * width + area.x + x] = source[(area.y + sy) * width + area.x + sx];
  }
}
export function applyOperations(input, operations) {
  const project = validateProject(input);
  if (!Array.isArray(operations) || operations.length > 20000) throw new Error('Expected at most 20,000 drawing operations.');
  let activeLayer = project.layers.at(-1).id;
  for (const op of operations) {
    if (op.op === 'layer') {
      const added = addLayer(project, text(op.name, 'Layer name'));
      activeLayer = added.id;
      continue;
    }
    const frame = project.frames[integer(op.frame ?? 0, 0, project.frames.length - 1, 'Frame index')];
    const layer = op.layer ? project.layers.find((l) => l.id === op.layer || l.name === op.layer) : project.layers.find((l) => l.id === activeLayer);
    if (!layer) throw new Error(`Layer not found: ${op.layer}`);
    if (layer.locked) throw new Error(`Layer is locked: ${layer.name}`);
    const pixels = frame.cels[layer.id], value = color(op.color ?? null);
    const x = integer(op.x, 0, project.width - 1, 'X'), y = integer(op.y, 0, project.height - 1, 'Y');
    if (op.op === 'fill') floodFill(pixels, project.width, project.height, x, y, value);
    else if (op.op === 'pixel') paint(pixels, project.width, project.height, [[x, y]], value);
    else if (['line', 'rect', 'ellipse'].includes(op.op)) {
      const x2 = integer(op.x2, 0, project.width - 1, 'X2'), y2 = integer(op.y2, 0, project.height - 1, 'Y2');
      paint(pixels, project.width, project.height, shapePoints(op.op, x, y, x2, y2, !!op.filled), value);
    } else throw new Error(`Unknown drawing operation: ${op.op}`);
    if (value && !project.palette.includes(value) && project.palette.length < 256) project.palette.push(value);
  }
  return validateProject(project);
}
