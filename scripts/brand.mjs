import { composite, validateProject, rgba } from '../web/lib/model.js';
import { encodePng } from './png.mjs';

function svg(project) {
  const pixels = composite(project);
  const rectangles = [];
  for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
    const i = (y * project.width + x) * 4, [r, g, b, a] = pixels.subarray(i, i + 4);
    if (!a) continue;
    rectangles.push(`  <rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${r},${g},${b})" opacity="${a / 255}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${project.width * 2}" height="${project.height * 2}" viewBox="0 0 ${project.width} ${project.height}" shape-rendering="crispEdges">
  <title>SpriteCanvas scout</title>
${rectangles.join('\n')}
</svg>
`;
}

export function brandAssets(source) {
  const project = validateProject(source);
  if (project.frames.length !== 1 || project.width !== project.height) {
    throw new Error('The character logo must be a square, single-frame pixel project.');
  }
  const flare = project.layers.find(layer => layer.id === 'camera-lens-flare');
  if (!flare?.visible || !flare.opacity || !project.frames[0].cels[flare.id].some(pixel => pixel && rgba(pixel)[3])) {
    throw new Error('The application and README logo require a visible camera-lens-flare layer.');
  }
  const clean = { ...project, layers: project.layers.filter(layer => layer.id !== flare.id) };
  const pixels = composite(clean);
  let left = project.width, top = project.height, right = -1, bottom = -1;
  for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
    if (!pixels[(y * project.width + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('The favicon needs visible character pixels without the lens flare.');
  left = Math.max(0, left - 2); top = Math.max(0, top - 2);
  right = Math.min(project.width - 1, right + 2); bottom = Math.min(project.height - 1, bottom + 2);
  const faviconProject = {
    ...clean, width: right - left + 1, height: bottom - top + 1,
    frames: clean.frames.map(frame => ({ ...frame, cels: Object.fromEntries(clean.layers.map(layer => [
      layer.id, Array.from({ length: bottom - top + 1 }, (_, row) =>
        frame.cels[layer.id].slice((top + row) * project.width + left, (top + row) * project.width + right + 1)).flat(),
    ])) })),
  };
  return { svg: svg(project), png: encodePng(project, 0, 32), faviconSvg: svg(faviconProject), faviconProject };
}
