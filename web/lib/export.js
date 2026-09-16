import { composite } from './model.js';
import { encodeGif } from './gif.js';

export function renderPixels(canvas, pixels, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
}
export function projectCanvas(project, frame = 0) {
  const canvas = document.createElement('canvas');
  renderPixels(canvas, composite(project, frame), project.width, project.height);
  return canvas;
}
export function safeName(name) {
  return name.replace(/[^a-z\d_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'sprite';
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function downloadJson(data, name) {
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
}
async function downloadCanvas(canvas, name) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed. Try a smaller export.');
  download(blob, name);
}
export async function exportProject(project, { format = 'png', frame = 0, scale = 1, columns = 8 } = {}) {
  const name = safeName(project.name);
  if (format === 'project') {
    downloadJson(project, `${name}.spritecanvas.json`);
    return;
  }
  const frames = project.frames.length;
  if (format === 'gif') {
    download(new Blob([encodeGif(project, scale)], { type: 'image/gif' }), `${name}.gif`);
    return;
  }
  if (format === 'svg') {
    const pixels = composite(project, frame);
    const rectangles = [];
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) {
      const i = (y * project.width + x) * 4;
      if (!pixels[i + 3]) continue;
      rectangles.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})" opacity="${pixels[i + 3] / 255}"/>`);
    }
    download(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${project.width * scale}" height="${project.height * scale}" viewBox="0 0 ${project.width} ${project.height}" shape-rendering="crispEdges">${rectangles.join('')}</svg>`], { type: 'image/svg+xml' }), `${name}.svg`);
    return;
  }
  const cols = format === 'sheet' ? Math.min(columns, frames) : 1;
  const rows = format === 'sheet' ? Math.ceil(frames / cols) : 1;
  const width = project.width * cols * scale, height = project.height * rows * scale;
  if (width * height > 16_000_000 || width > 16384 || height > 16384) throw new Error('Export dimensions are too large. Reduce scale or adjust sheet columns.');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  if (format === 'sheet') {
    const metadata = { image: `${name}-sheet.png`, width, height, scale, frames: [] };
    for (let i = 0; i < frames; i++) {
      const x = (i % cols) * project.width * scale, y = Math.floor(i / cols) * project.height * scale;
      context.drawImage(projectCanvas(project, i), x, y, project.width * scale, project.height * scale);
      metadata.frames.push({ id: project.frames[i].id, x, y, width: project.width * scale, height: project.height * scale, duration: project.frames[i].duration });
    }
    await downloadCanvas(canvas, `${name}-sheet.png`);
    downloadJson(metadata, `${name}-sheet.json`);
  } else {
    context.drawImage(projectCanvas(project, frame), 0, 0, width, height);
    await downloadCanvas(canvas, `${name}.png`);
  }
}
