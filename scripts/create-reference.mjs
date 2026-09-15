import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProject, addLayer, color, paint, shapePoints, validateProject } from '../web/lib/model.js';
import { encodePng } from './png.mjs';

// Hand-reconstructed on a 50x50 grid from the user's supplied reference.
// Each token below is one editable pixel, not a raster-image overlay.
export function createReference(projectId = 'golden-helmet-reference') {
  const project = createProject(50, 50, 'Golden helmet');
  project.id = projectId;
  const colors = {
    '.': null, '#': '#030604', o: '#FFAD13', y: '#FFF052', w: '#FFF3E7',
    b: '#B96B49', n: '#243454', g: '#B8BCB9', s: '#666052',
  };
  const rows = [
    '. . . . . # # # # # # . . . . .',
    '. . . . # o # o # b # # . . . .',
    '. . . # o # o # o o b b # . . .',
    '. . # o y # y # y o o b b # . .',
    '. # o y # y # y y y o o b b # .',
    '. # n s # w # s s n n n # # # .',
    '. # n s w w w s s n n n # # # .',
    '# b o y y w y y y o o o o b b #',
    '. # # # # # # # # # # # # n n .',
    '. # w # # w w w # # w w n n g .',
    '. # w # # w w w # # w g n n g .',
    '. # # g g g # # g g g g # n n .',
    '. . # # # # # # # # # # # # . .',
    '. # o o b # # # # # o y o b # .',
    '# o y y o b # # # o y w y o b #',
    '. # # # # # # # . # # # # # # .',
  ];
  const backdrop = project.layers[0];
  backdrop.name = 'Emerald backdrop'; backdrop.locked = true;
  backdrop.id = 'backdrop';
  project.frames[0] = { id: 'frame-1', duration: 150, cels: { backdrop: Array(2500).fill(color('#008657')) } };
  const border = addLayer(project, 'Warm ivory frame');
  delete project.frames[0].cels[border.id]; border.id = 'border';
  project.frames[0].cels.border = Array(2500).fill(null);
  paint(project.frames[0].cels.border, 50, 50, shapePoints('rect', 9, 9, 40, 40), color('#F8D19B'));
  const helmet = addLayer(project, 'Golden helmet');
  delete project.frames[0].cels[helmet.id]; helmet.id = 'helmet';
  project.frames[0].cels.helmet = Array(2500).fill(null);
  rows.forEach((row, y) => {
    const pixels = row.split(' ');
    if (pixels.length !== 16) throw new Error(`Reference row ${y} has ${pixels.length} pixels instead of 16.`);
    pixels.forEach((token, x) => {
      if (!(token in colors)) throw new Error(`Unknown reference token: ${token}`);
      project.frames[0].cels.helmet[(17 + y) * 50 + 17 + x] = color(colors[token]);
    });
  });
  project.palette = ['#008657', '#F8D19B', ...Object.values(colors).filter(Boolean)].map(color);
  return validateProject(project);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const project = createReference();
  mkdirSync(new URL('../web/examples/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../web/examples/helmet.spritecanvas.json', import.meta.url), JSON.stringify(project));
  writeFileSync(new URL('../web/examples/helmet.png', import.meta.url), encodePng(project, 0, 16));
  console.log('Created editable 50x50 reference project and crisp 800x800 PNG.');
}
