import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, validateProject, color, addLayer, addFrame, clone, paint, linePoints,
  shapePoints, floodFill, composite, difference, resizeProject, transformCel, applyOperations, sameProject,
} from '../web/lib/model.js';
import { encodeGif } from '../web/lib/gif.js';
import { createReference } from '../scripts/create-reference.mjs';
import { encodePng } from '../scripts/png.mjs';

test('project format validates and normalizes losslessly', () => {
  const project = createProject(16, 24);
  assert.deepEqual(validateProject(project), project);
  assert.equal(color('#aabbcc'), '#AABBCCFF');
  assert.equal(color('#aabbcc00'), null);
  assert.throws(() => color('red'), /Invalid pixel/);
  assert.throws(() => createProject(0, 3), /Width/);
  assert.throws(() => validateProject({ ...project, width: 257 }), /Width/);
  const bad = clone(project); bad.frames[0].cels[bad.layers[0].id].pop();
  assert.throws(() => validateProject(bad), /pixel count/);
});
test('validation rejects unsafe IDs, invalid data, duplicates and excessive allocations', () => {
  const project = createProject(8, 8);
  const bad = clone(project); bad.layers[0].id = '__proto__';
  assert.throws(() => validateProject(bad), /safe identifiers/);
  const duplicate = clone(project); duplicate.layers.push(duplicate.layers[0]);
  assert.throws(() => validateProject(duplicate), /safe identifiers/);
  const timing = clone(project); timing.frames[0].duration = 0;
  assert.throws(() => validateProject(timing), /Frame duration/);
  const oversized = createProject(256, 256);
  for (let i = 0; i < 23; i++) addLayer(oversized);
  assert.throws(() => addFrame(oversized), /pixel limit/);
});
test('Bresenham strokes are continuous, reversible, and include endpoints', () => {
  assert.deepEqual(linePoints(0, 0, 3, 3), [[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(linePoints(3, 3, 0, 0), [[3, 3], [2, 2], [1, 1], [0, 0]]);
  assert.equal(linePoints(0, 0, 9, 2).length, 10);
  const pixels = Array(100).fill(null);
  paint(pixels, 10, 10, [[2, 3]], '#FF0000FF', { mirrorX: true, mirrorY: true });
  assert.equal(pixels.filter(Boolean).length, 4);
  assert.equal(pixels[67], '#FF0000FF');
});
test('selection clips brush, mirrored strokes, fill and transforms', () => {
  const pixels = Array(25).fill(null), selection = { x: 1, y: 1, w: 2, h: 2 };
  paint(pixels, 5, 5, [[1, 1]], '#FF0000FF', { size: 5, selection });
  assert.equal(pixels.filter(Boolean).length, 4);
  floodFill(pixels, 5, 5, 1, 1, '#00FF00FF', selection);
  assert.equal(pixels.filter((p) => p === '#00FF00FF').length, 4);
  pixels[6] = '#FFFFFFFF';
  transformCel(pixels, 5, 5, 'flip-x', selection);
  assert.equal(pixels[7], '#FFFFFFFF');
  assert.throws(() => transformCel(pixels, 5, 5, 'rotate', { x: 0, y: 0, w: 3, h: 2 }), /square/);
});
test('fill stops at outlines and same-color fill terminates', () => {
  const pixels = Array(49).fill(null);
  paint(pixels, 7, 7, shapePoints('rect', 1, 1, 5, 5), '#000000FF');
  floodFill(pixels, 7, 7, 3, 3, '#FF0000FF');
  assert.equal(pixels.filter((p) => p === '#FF0000FF').length, 9);
  assert.equal(pixels[0], null);
  floodFill(pixels, 7, 7, 3, 3, '#FF0000FF');
  assert.equal(pixels.filter(Boolean).length, 25);
});
test('ellipses respect bounding rectangles, fill, and single-pixel shapes', () => {
  assert.deepEqual(shapePoints('ellipse', 3, 4, 3, 4), [[3, 4]]);
  const outline = shapePoints('ellipse', 0, 0, 10, 6);
  const filled = shapePoints('ellipse', 0, 0, 10, 6, true);
  assert.ok(filled.length > outline.length);
  assert.ok(outline.every(([x, y]) => x >= 0 && x <= 10 && y >= 0 && y <= 6));
});
test('layer compositing obeys alpha, visibility and order', () => {
  const project = createProject(1, 1);
  project.frames[0].cels[project.layers[0].id][0] = '#0000FFFF';
  const upper = addLayer(project); upper.opacity = 0.5;
  project.frames[0].cels[upper.id][0] = '#FF0000FF';
  assert.deepEqual([...composite(project)], [128, 0, 128, 255]);
  upper.visible = false;
  assert.deepEqual([...composite(project)], [0, 0, 255, 255]);
  upper.visible = true; upper.opacity = 1;
  assert.deepEqual([...composite(project)], [255, 0, 0, 255]);
});
test('frames and layers have independent cels', () => {
  const project = createProject(3, 3);
  project.frames[0].cels[project.layers[0].id][0] = '#FFFFFFFF';
  addFrame(project, 0);
  project.frames[1].cels[project.layers[0].id][0] = null;
  assert.equal(project.frames[0].cels[project.layers[0].id][0], '#FFFFFFFF');
  const added = addLayer(project);
  assert.equal(project.frames[1].cels[added.id].length, 9);
  assert.ok(sameProject(project, validateProject(project)));
});
test('resize preserves coordinates on every frame and layer, and crops predictably', () => {
  const project = createProject(2, 2);
  project.frames[0].cels[project.layers[0].id][0] = '#FFFFFFFF';
  addFrame(project, 0); addLayer(project);
  resizeProject(project, 4, 4, true);
  assert.equal(project.frames[1].cels[project.layers[0].id][5], '#FFFFFFFF');
  assert.equal(project.frames[1].cels[project.layers[1].id].length, 16);
  resizeProject(project, 1, 1, false);
  assert.equal(project.frames[0].cels[project.layers[0].id][0], null);
});
test('agent operations preserve base and produce real editable pixel changes', () => {
  const base = createProject(8, 8);
  const result = applyOperations(base, [
    { op: 'layer', name: 'Agent ink' },
    { op: 'rect', x: 1, y: 1, x2: 6, y2: 6, color: '#FF0000' },
    { op: 'fill', x: 2, y: 2, color: '#00FF00' },
    { op: 'pixel', x: 0, y: 0, color: '#FFFFFF' },
  ]);
  assert.equal(base.layers.length, 1);
  assert.equal(result.layers.length, 2);
  assert.equal(difference(base, result).count, 37);
  base.layers[0].locked = true;
  assert.throws(() => applyOperations(base, [{ op: 'pixel', x: 0, y: 0, color: '#000000' }]), /locked/);
  assert.throws(() => applyOperations(result, [{ op: 'pixel', x: 99, y: 0 }]), /X must/);
  assert.throws(() => applyOperations(result, [{ op: 'invalid', x: 0, y: 0 }]), /Unknown/);
});
test('difference counts removed pixels and dimension changes correctly', () => {
  const a = createProject(2, 2), b = clone(a);
  b.frames[0].cels[b.layers[0].id][0] = '#FFFFFFFF';
  assert.equal(difference(a, b).count, 1);
  resizeProject(b, 4, 4, false);
  assert.equal(difference(a, b).width, 4);
  assert.equal(difference(a, b).count, 1);
});
test('reference is hand-authored editable artwork, with deterministic exports', () => {
  const reference = createReference();
  assert.equal(reference.width, 50); assert.equal(reference.height, 50);
  assert.equal(reference.layers.length, 3);
  assert.equal(reference.frames[0].cels.border.filter(Boolean).length, 124);
  assert.ok(reference.frames[0].cels.helmet.filter(Boolean).length > 170);
  const png = encodePng(reference, 0, 16);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 800);
  const gif = encodeGif(reference);
  assert.equal(Buffer.from(gif.slice(0, 6)).toString(), 'GIF89a');
  assert.equal(gif.at(-1), 0x3B);
});
