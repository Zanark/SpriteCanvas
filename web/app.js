import {
  clone, color, createProject, validateProject, sameProject, composite, difference, fromRgba,
  linePoints, shapePoints, paint, floodFill, inSelection, addLayer, addFrame, resizeProject,
  transformCel, integer, uid,
} from './lib/model.js';
import { openStorage, readStorage, writeStorage, api } from './lib/storage.js';
import { renderPixels, projectCanvas, downloadJson, safeName, exportProject } from './lib/export.js';
import { createFeedback, latestFeedback, replacementDetails, resolveFeedback, validateReference, MAX_REFERENCE_BYTES, MAX_FEEDBACK_ENTRIES } from './lib/review.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icons = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const tools = [
  ['pencil', 'Pencil', 'B'], ['eraser', 'Eraser', 'E'], ['fill', 'Paint bucket', 'F'],
  ['picker', 'Eyedropper', 'I'], ['line', 'Line', 'L'], ['rect', 'Rectangle', 'U'],
  ['ellipse', 'Ellipse', 'O'], ['select', 'Marquee selection', 'M'], ['move', 'Move', 'V'], ['hand', 'Hand', 'H'],
];
let project = createProject(), frameIndex = 0, layerId = project.layers[0].id;
let tool = 'pencil', foreground = color('#FFAF24'), background = color('#11131D');
let zoom = 10, pan = { x: 0, y: 0 }, grid = false, mirrorX = false, mirrorY = false, fitted = true;
let selection = null, clipboard = null, drag = null, hover = null, spaceHeld = false;
let undoStack = [], redoStack = [], playing = false, playbackTimer = null;
let db = null, bridge = false, bridgeOnline = false, revision = 0, dirty = false, conflict = false;
let proposal = null, comparison = null, changeSerial = 0, savePromise = null, saveTimer = null;
let noticeTimer = null, currentComparison = null, compareMode = 'side';
let textCallback = null, importedImage = null, storageAvailable = true;
let feedback = [], feedbackReference = null, feedbackProposalId = null, feedbackRenderKey = '';
let reviewBusy = false, referenceLoading = false, reviewEpoch = 0, referenceRead = 0;
const overlay = $('#overlay-canvas'), artCanvas = $('#art-canvas'), stage = $('#stage');
const themeColor = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function notify(message, error = false) {
  clearTimeout(noticeTimer);
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error); notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 14000 : 5500);
}
async function guard(action) {
  try { await action(); }
  catch (error) { console.error(error); notify(error.message || String(error), true); }
}
const cel = () => project.frames[frameIndex].cels[layerId];
const layer = () => project.layers.find((entry) => entry.id === layerId);
function editable() {
  if (playing) throw new Error('Pause playback before editing.');
  if (layer().locked) throw new Error('This layer is locked. Unlock it or add a new layer.');
  if (!layer().visible) throw new Error('This layer is hidden. Make it visible before drawing.');
}
function normalizeView() {
  frameIndex = Math.min(frameIndex, project.frames.length - 1);
  if (!project.layers.some((entry) => entry.id === layerId)) layerId = project.layers.at(-1).id;
}
function historyPush(before) {
  undoStack.push(before);
  const weight = (p) => p.width * p.height * p.layers.length * p.frames.length;
  let total = undoStack.reduce((sum, entry) => sum + weight(entry), 0);
  while (undoStack.length > 1 && (undoStack.length > 40 || total > 4_000_000)) total -= weight(undoStack.shift());
}
function markChanged(before, recordHistory = true) {
  if (JSON.stringify(before) === JSON.stringify(project)) { renderAll(); return; }
  if (recordHistory) { historyPush(before); redoStack = []; }
  changeSerial++; dirty = true;
  if (!bridge) revision++;
  normalizeView(); renderAll(); scheduleSave();
}
function change(action) {
  if (drag) throw new Error('Finish the current stroke first.');
  stopPlayback();
  const before = clone(project);
  try { action(); }
  catch (error) { project = before; normalizeView(); renderAll(); throw error; }
  markChanged(before);
}
function setProject(next) {
  change(() => {
    project = validateProject(next); frameIndex = 0; layerId = project.layers.at(-1).id;
    selection = null; pan = { x: 0, y: 0 };
  });
  fitCanvas();
}
function cacheState(pending = dirty) {
  return { project: clone(project), revision, proposal: clone(proposal), comparison: clone(comparison), feedback: clone(feedback), bridge, pending };
}
function adoptReviewState(state) {
  proposal = state.proposal; comparison = state.comparison; feedback = state.feedback || [];
}
async function cache(pending = dirty) {
  if (!db) throw new Error('Browser autosave is unavailable. Download a project file to keep your work.');
  await writeStorage(db, cacheState(pending));
}
function scheduleSave() {
  clearTimeout(saveTimer);
  $('#save-status').textContent = bridge ? 'Saving to local workspace...' : 'Saving in this browser...';
  saveTimer = setTimeout(() => guard(flushSave), 400);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) {
    await savePromise;
    if (dirty && !conflict) return flushSave();
    return;
  }
  if (!dirty) return;
  savePromise = (async () => {
    let browserError = null;
    try { await cache(dirty); storageAvailable = true; }
    catch (error) { browserError = error; storageAvailable = false; }
    if (conflict) {
      renderConnection();
      throw new Error('Disk and browser have different revisions. Download your version or load the disk version before sharing a handoff.');
    }
    const serial = changeSerial;
    if (bridge) {
      try {
        const result = await api('project', { expectedRevision: revision, project: clone(project) });
        revision = result.revision; adoptReviewState(result);
        bridgeOnline = true;
        if (serial === changeSerial) dirty = false;
      } catch (error) {
        if (error.status === 409) conflict = true;
        else bridgeOnline = false;
        renderConnection();
        throw error;
      }
    } else {
      if (browserError) throw browserError;
      if (serial === changeSerial) dirty = false;
    }
    if (db) {
      try { await cache(dirty); storageAvailable = true; }
      catch (error) { browserError = error; storageAvailable = false; }
    }
    renderConnection();
    if (browserError) notify(browserError.message, true);
  })();
  try { await savePromise; }
  finally { savePromise = null; renderConnection(); }
  if (dirty && !conflict) scheduleSave();
}
function syncFromRemote(state, resetHistory = false) {
  project = validateProject(state.project); revision = state.revision;
  adoptReviewState(state);
  dirty = false; conflict = false; bridgeOnline = true; selection = null;
  if (resetHistory) { undoStack = []; redoStack = []; }
  normalizeView(); renderAll();
}
async function poll() {
  if (!bridge || savePromise || drag || reviewBusy) return;
  const serial = changeSerial;
  const epoch = reviewEpoch;
  try {
    const result = await api('workspace');
    if (savePromise || drag || reviewBusy || serial !== changeSerial || epoch !== reviewEpoch) return;
    bridgeOnline = true;
    if (result.revision !== revision) {
      if (dirty) conflict = true;
      else {
        syncFromRemote(result, true);
        await cache(false);
        if (!playing) fitCanvas();
      }
    } else {
      const isNew = result.proposal && result.proposal.id !== proposal?.id;
      adoptReviewState(result);
      if (isNew && $('#compare-dialog').open && $('#feedback-form').hidden) openCompare();
      if (isNew) notify('An agent proposal is ready. Compare versions to review it; your drawing has not changed.');
    }
    renderConnection();
    if (dirty && !conflict) scheduleSave();
  } catch (error) {
    if (bridgeOnline) notify(`Local bridge disconnected: ${error.message}. Your browser keeps a recovery copy.`, true);
    bridgeOnline = false; renderConnection();
  }
}
function renderConnection() {
  $('#conflict-banner').hidden = !conflict;
  const text = conflict ? 'Sync conflict - your browser edits are preserved'
    : bridge && !bridgeOnline ? 'Bridge offline - browser recovery copy only'
      : !storageAvailable && !bridge ? 'Browser autosave unavailable - download your project'
        : dirty ? 'Unsaved changes'
          : bridge ? `Saved locally - revision ${revision}` : 'Autosaved in this browser';
  $('#save-status').textContent = text;
  $('#save-status').classList.toggle('error', conflict || (bridge && !bridgeOnline) || (!storageAvailable && !bridge));
  $('#bridge-badge').textContent = bridge ? bridgeOnline ? 'LOCAL LIVE' : 'OFFLINE' : 'STATIC';
  $('#connection-status').textContent = bridge ? bridgeOnline ? 'Local bridge connected' : 'Local bridge offline' : 'Browser workspace';
  $('#bridge-description').textContent = bridge
    ? 'Your agent can read this saved canvas and draw on a separate version. You decide what stays.'
    : 'Share an editable snapshot with your agent. Review their work without losing yours.';
  $('#local-note').textContent = bridge
    ? `Revision ${revision} on disk. No cloud or embedded AI. Keep this local server running while collaborating.`
    : 'No AI service is embedded. Your agent works through a local bridge or project files.';
  $('#proposal-dot').hidden = !proposal;
  $('#proposal-card').hidden = !proposal;
  if (proposal) $('#proposal-title').textContent = proposal.title + (proposal.baseRevision !== revision || dirty ? ' (canvas changed)' : '');
  if (currentComparison && $('#compare-dialog').open) { updateCompareSafety(); renderReviewHistory(); }
}
function renderAll() {
  normalizeView();
  $('#project-name').textContent = project.name;
  $('#canvas-title').textContent = project.name;
  $('#canvas-size').textContent = `${project.width} x ${project.height}`;
  $('#preview-size').textContent = `${project.width} x ${project.height}`;
  $('#active-layer-status').textContent = layer().name + (layer().locked ? ' / LOCKED' : '');
  $('#selection-info').textContent = selection ? `${selection.w} x ${selection.h} selection` : 'No selection';
  $$('[data-action="undo"]').forEach((button) => { button.disabled = !undoStack.length; });
  $$('[data-action="redo"]').forEach((button) => { button.disabled = !redoStack.length; });
  renderPalette(); renderLayers(); renderFrames(); renderCanvas(); renderConnection();
}
function renderPalette() {
  $('#palette-count').textContent = String(project.palette.length);
  renderPaletteSwatches($('#palette'), project.palette, true);
}
function renderPaletteSwatches(container, colors, selectable = false) {
  container.replaceChildren(...colors.map((swatch) => {
    const element = document.createElement(selectable ? 'button' : 'span');
    element.className = 'swatch' + (selectable && swatch === foreground ? ' selected' : '');
    element.style.background = swatch; element.style.setProperty('--swatch', swatch);
    element.title = swatch;
    element.setAttribute('aria-label', selectable ? `Use color ${swatch}` : swatch);
    if (selectable) { element.type = 'button'; element.dataset.color = swatch; }
    else element.setAttribute('role', 'img');
    return element;
  }));
}
function updateColor() {
  $('#foreground').value = foreground?.slice(0, 7) || '#000000';
  $('#background').value = background?.slice(0, 7) || '#000000';
  $('#hex-color').value = foreground?.endsWith('FF') ? foreground.slice(0, 7) : foreground || '#00000000';
  renderPalette();
}
function renderLayers() {
  $('#layers').replaceChildren();
  $('#layer-count').textContent = String(project.layers.length).padStart(2, '0');
  for (const entry of [...project.layers].reverse()) {
    const row = document.createElement('div');
    row.className = 'layer' + (entry.id === layerId ? ' selected' : '');
    row.dataset.layerId = entry.id;
    const visibility = document.createElement('button');
    visibility.innerHTML = icons('eye');
    visibility.dataset.layerAction = 'visibility';
    visibility.setAttribute('aria-label', `${entry.visible ? 'Hide' : 'Show'} ${entry.name}`);
    visibility.title = visibility.getAttribute('aria-label');
    if (!entry.visible) visibility.className = 'dim';
    const thumb = document.createElement('canvas');
    const thumbnailProject = { ...project, layers: [{ ...entry, visible: true, opacity: 1 }] };
    renderPixels(thumb, composite(thumbnailProject, frameIndex), project.width, project.height);
    const name = document.createElement('button');
    name.textContent = entry.name; name.className = 'layer-name';
    name.dataset.layerAction = 'select'; name.title = `${entry.name} (double-click to rename)`;
    const lock = document.createElement('button');
    lock.innerHTML = icons('lock'); lock.dataset.layerAction = 'lock';
    lock.setAttribute('aria-label', `${entry.locked ? 'Unlock' : 'Lock'} ${entry.name}`);
    lock.title = lock.getAttribute('aria-label'); lock.className = entry.locked ? '' : 'dim';
    row.append(visibility, thumb, name, lock); $('#layers').append(row);
  }
  $('#layer-opacity').value = Math.round(layer().opacity * 100);
  $('#layer-opacity').disabled = layer().locked;
  $('#opacity-label').textContent = `${Math.round(layer().opacity * 100)}%`;
}
function renderFrames() {
  $('#frames').replaceChildren();
  for (let i = 0; i < project.frames.length; i++) {
    const button = document.createElement('button');
    button.className = 'frame' + (i === frameIndex ? ' active' : '');
    button.dataset.frame = i; button.setAttribute('aria-label', `Frame ${i + 1}`);
    const canvas = projectCanvas(project, i);
    const number = document.createElement('span');
    number.textContent = String(i + 1).padStart(2, '0');
    button.append(canvas, number); $('#frames').append(button);
  }
  $('#frame-count').textContent = String(project.frames.length).padStart(2, '0');
  $('#frame-duration').value = project.frames[frameIndex].duration;
  const total = project.frames.reduce((sum, frame) => sum + frame.duration, 0);
  $('#animation-info').textContent = `${project.frames.length} frame${project.frames.length === 1 ? '' : 's'} / ${total} ms loop`;
}
function renderCanvas() {
  const rendered = composite(project, frameIndex);
  renderPixels(artCanvas, rendered, project.width, project.height);
  if ($('#onion-toggle').checked && !playing && project.frames.length > 1) {
    const context = artCanvas.getContext('2d');
    context.save(); context.globalCompositeOperation = 'destination-over'; context.globalAlpha = 0.25;
    context.drawImage(projectCanvas(project, (frameIndex + project.frames.length - 1) % project.frames.length), 0, 0);
    context.restore();
  }
  const preview = $('#preview-canvas');
  renderPixels(preview, rendered, project.width, project.height);
  const nav = $('.navigator');
  const factor = Math.max(1, Math.floor(Math.min((nav.clientWidth - 20) / project.width, (nav.clientHeight - 12) / project.height)));
  preview.style.width = `${project.width * factor}px`; preview.style.height = `${project.height * factor}px`;
  positionCanvas(); renderOverlay();
}
function positionCanvas() {
  const width = project.width * zoom, height = project.height * zoom;
  const wrap = $('#canvas-wrap');
  wrap.style.width = `${width}px`; wrap.style.height = `${height}px`;
  wrap.style.transform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`;
  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;
  $('#zoom-label').textContent = `${zoom * 100}%`;
}
function renderOverlay() {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (grid && zoom >= 5) {
    ctx.beginPath(); ctx.strokeStyle = themeColor('--grid'); ctx.lineWidth = 1;
    for (let x = 0; x <= project.width; x++) { ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, overlay.height); }
    for (let y = 0; y <= project.height; y++) { ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(overlay.width, y * zoom + 0.5); }
    ctx.stroke();
  }
  if (mirrorX || mirrorY) {
    ctx.strokeStyle = themeColor('--guide'); ctx.setLineDash([4, 4]); ctx.beginPath();
    if (mirrorX) { ctx.moveTo(overlay.width / 2, 0); ctx.lineTo(overlay.width / 2, overlay.height); }
    if (mirrorY) { ctx.moveTo(0, overlay.height / 2); ctx.lineTo(overlay.width, overlay.height / 2); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (selection) {
    const { x, y, w, h } = selection;
    ctx.strokeStyle = themeColor('--selection-dark'); ctx.lineWidth = 2; ctx.strokeRect(x * zoom + 1, y * zoom + 1, w * zoom - 2, h * zoom - 2);
    ctx.strokeStyle = themeColor('--selection-light'); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.strokeRect(x * zoom + 0.5, y * zoom + 0.5, w * zoom - 1, h * zoom - 1); ctx.setLineDash([]);
  }
  if (hover && !drag && ['pencil', 'eraser'].includes(tool)) {
    const size = brushSize(), offset = Math.floor(size / 2);
    ctx.strokeStyle = themeColor('--cursor'); ctx.lineWidth = 1;
    ctx.strokeRect((hover.x - offset) * zoom + 0.5, (hover.y - offset) * zoom + 0.5, size * zoom - 1, size * zoom - 1);
  }
}
function fitCanvas() {
  fitted = true;
  const padding = stage.clientWidth < 500 ? 48 : 110;
  zoom = Math.max(1, Math.min(32, Math.floor(Math.min((stage.clientWidth - padding) / project.width, (stage.clientHeight - 100) / project.height))));
  pan = { x: 0, y: 0 }; renderCanvas();
}
function setZoom(value) {
  fitted = false;
  zoom = Math.max(1, Math.min(32, Math.floor(4096 / Math.max(project.width, project.height)), value));
  positionCanvas(); renderOverlay();
}
function setTool(next) {
  tool = next;
  $$('[data-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === tool);
    button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  });
  $('#tool-name').textContent = tools.find(([id]) => id === tool)[1].replace('Marquee ', '').replace('Paint ', '');
  overlay.style.cursor = tool === 'hand' ? 'grab' : tool === 'move' ? 'move' : 'crosshair';
  renderOverlay();
}
const brushSize = () => Math.max(1, Math.min(32, Math.round(Number($('#brush-size').value) || 1)));
function point(event, clamp = false) {
  const bounds = overlay.getBoundingClientRect();
  let x = Math.floor((event.clientX - bounds.left) / zoom), y = Math.floor((event.clientY - bounds.top) / zoom);
  if (clamp) { x = Math.max(0, Math.min(project.width - 1, x)); y = Math.max(0, Math.min(project.height - 1, y)); }
  return { x, y };
}
function pick(x, y) {
  if (x < 0 || y < 0 || x >= project.width || y >= project.height) return;
  const data = composite(project, frameIndex), i = (y * project.width + x) * 4;
  foreground = fromRgba(...data.slice(i, i + 4));
  updateColor();
}
function paintPoints(points, value) {
  paint(cel(), project.width, project.height, points, value, { size: brushSize(), mirrorX, mirrorY, selection });
}
function movePixels(source, area, dx, dy) {
  const target = [...source];
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) target[(area.y + y) * project.width + area.x + x] = null;
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) {
    const tx = area.x + x + dx, ty = area.y + y + dy;
    if (tx >= 0 && ty >= 0 && tx < project.width && ty < project.height) target[ty * project.width + tx] = source[(area.y + y) * project.width + area.x + x];
  }
  return target;
}
function clippedArea(area, dx, dy) {
  const x = Math.max(0, area.x + dx), y = Math.max(0, area.y + dy);
  const right = Math.min(project.width, area.x + area.w + dx), bottom = Math.min(project.height, area.y + area.h + dy);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}
function pointerDown(event) {
  if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
  event.preventDefault();
  overlay.focus({ preventScroll: true });
  if (drag) return;
  const pos = point(event);
  if (spaceHeld || event.button === 1 || tool === 'hand') {
    fitted = false;
    drag = { mode: 'pan', clientX: event.clientX, clientY: event.clientY, pan: { ...pan }, pointerId: event.pointerId };
  } else {
    if (pos.x < 0 || pos.y < 0 || pos.x >= project.width || pos.y >= project.height) return;
    if (event.altKey || tool === 'picker') { pick(pos.x, pos.y); return; }
    if (playing) throw new Error('Pause playback before editing.');
    if (tool !== 'select') editable();
    const value = tool === 'eraser' ? null : event.button === 2 ? background : foreground;
    drag = {
      mode: tool, start: pos, last: pos, before: clone(project), value, selection: clone(selection),
      pixels: [...cel()], pointerId: event.pointerId, area: selection || { x: 0, y: 0, w: project.width, h: project.height },
    };
    if (tool === 'fill') {
      floodFill(cel(), project.width, project.height, pos.x, pos.y, value, selection);
      finishStroke(false); return;
    }
    if (['pencil', 'eraser'].includes(tool)) paintPoints([[pos.x, pos.y]], value);
    if (tool === 'select') selection = { x: pos.x, y: pos.y, w: 1, h: 1 };
    if (['line', 'rect', 'ellipse'].includes(tool)) paintPoints([[pos.x, pos.y]], value);
  }
  overlay.setPointerCapture(event.pointerId); renderCanvas();
}
function pointerMove(event) {
  const pos = point(event, !!drag && drag.mode !== 'pan');
  hover = pos;
  $('#cursor-status').textContent = `X: ${pos.x}   Y: ${pos.y}`;
  if (!drag) { renderOverlay(); return; }
  if (drag.mode === 'pan') {
    pan = { x: drag.pan.x + event.clientX - drag.clientX, y: drag.pan.y + event.clientY - drag.clientY };
    positionCanvas(); return;
  }
  const { start, value } = drag;
  if (['pencil', 'eraser'].includes(drag.mode)) paintPoints(linePoints(drag.last.x, drag.last.y, pos.x, pos.y), value);
  else if (['line', 'rect', 'ellipse'].includes(drag.mode)) {
    project.frames[frameIndex].cels[layerId] = [...drag.pixels];
    paintPoints(shapePoints(drag.mode, start.x, start.y, pos.x, pos.y, $('#filled-shape').checked), value);
  } else if (drag.mode === 'select') {
    selection = { x: Math.min(start.x, pos.x), y: Math.min(start.y, pos.y), w: Math.abs(start.x - pos.x) + 1, h: Math.abs(start.y - pos.y) + 1 };
  } else if (drag.mode === 'move') {
    const dx = pos.x - start.x, dy = pos.y - start.y;
    project.frames[frameIndex].cels[layerId] = movePixels(drag.pixels, drag.area, dx, dy);
    if (drag.selection) selection = clippedArea(drag.area, dx, dy);
  }
  drag.last = pos; renderCanvas();
}
function finishStroke(cancelled = false) {
  if (!drag) return;
  const completed = drag; drag = null;
  if (overlay.hasPointerCapture(completed.pointerId)) overlay.releasePointerCapture(completed.pointerId);
  if (cancelled && completed.before) { project = completed.before; selection = completed.selection; }
  else if (completed.before && completed.mode !== 'select') markChanged(completed.before);
  renderAll();
}
function undo() {
  if (!undoStack.length) return;
  stopPlayback(); selection = null;
  const before = clone(project);
  redoStack.push(before); project = undoStack.pop();
  markChanged(before, false);
}
function redo() {
  if (!redoStack.length) return;
  stopPlayback(); selection = null;
  const before = clone(project);
  historyPush(before); project = redoStack.pop();
  markChanged(before, false);
}
function copyPixels(cut = false) {
  const area = selection || { x: 0, y: 0, w: project.width, h: project.height };
  clipboard = { ...area, pixels: [] };
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) clipboard.pixels.push(cel()[(area.y + y) * project.width + area.x + x]);
  if (cut) clearPixels();
  notify(`Copied ${area.w} x ${area.h} pixels to the studio clipboard.`);
}
function clearPixels() {
  editable();
  change(() => {
    for (let y = 0; y < project.height; y++) for (let x = 0; x < project.width; x++) if (inSelection(x, y, selection)) cel()[y * project.width + x] = null;
  });
}
function pastePixels() {
  editable();
  if (!clipboard) throw new Error('Copy a selection or cel first.');
  change(() => {
    const x0 = selection?.x ?? Math.min(clipboard.x, project.width - 1), y0 = selection?.y ?? Math.min(clipboard.y, project.height - 1);
    for (let y = 0; y < clipboard.h; y++) for (let x = 0; x < clipboard.w; x++) {
      if (x + x0 < project.width && y + y0 < project.height) cel()[(y0 + y) * project.width + x0 + x] = clipboard.pixels[y * clipboard.w + x];
    }
    selection = { x: x0, y: y0, w: Math.min(clipboard.w, project.width - x0), h: Math.min(clipboard.h, project.height - y0) };
  });
  setTool('move');
}
function stopPlayback() {
  clearTimeout(playbackTimer); playbackTimer = null; playing = false;
  $('#play-button').innerHTML = `${icons('play')}Play`;
}
function play() {
  if (playing) { stopPlayback(); renderAll(); return; }
  if (project.frames.length < 2) throw new Error('Add or duplicate a frame to animate your sprite.');
  playing = true; $('#play-button').textContent = 'Pause';
  function advance() {
    playbackTimer = setTimeout(() => {
      frameIndex = (frameIndex + 1) % project.frames.length;
      renderCanvas();
      $$('[data-frame]').forEach((button) => button.classList.toggle('active', Number(button.dataset.frame) === frameIndex));
      $('#frame-duration').value = project.frames[frameIndex].duration;
      advance();
    }, project.frames[frameIndex].duration);
  }
  advance();
}
function rename(title, initial, callback) {
  $('#text-title').textContent = title; $('#text-input').value = initial; textCallback = callback;
  $('#text-dialog').showModal(); $('#text-input').select();
}
function downloadProject() {
  downloadJson(project, `${safeName(project.name)}.spritecanvas.json`);
  notify('Editable project downloaded. It includes every layer and animation frame.');
}
async function reference() {
  const response = await fetch(new URL('./examples/helmet.spritecanvas.json', document.baseURI));
  if (!response.ok) throw new Error('Could not load the bundled reference artwork.');
  return validateProject(await response.json());
}
function validateProposal(input) {
  if (!input || input.format !== 'spritecanvas-proposal' || input.version !== 1) throw new Error('Expected a spritecanvas-proposal v1 file containing baseProject and project.');
  const baseProject = validateProject(input.baseProject), candidate = validateProject(input.project);
  if (!sameProject(baseProject, project)) throw new Error('This proposal targets a different or older canvas. Share a fresh handoff and ask the agent to rebase.');
  if (candidate.id !== project.id) throw new Error('A proposal must preserve your project ID.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('Proposal needs a title of 1-160 characters.');
  const replacement = replacementDetails(proposal, feedback, input.replacesProposalId, input.respondsTo);
  return { id: uid(), baseRevision: revision, baseProject, project: candidate, title: input.title, createdAt: new Date().toISOString(), ...replacement };
}
async function importProposal(file) {
  if (file.size > 32 * 1024 * 1024) throw new Error('Proposal exceeds the 32 MB limit.');
  await flushSave();
  const parsed = validateProposal(JSON.parse(await file.text()));
  reviewEpoch++;
  if (bridge) {
    const result = await api('proposals', {
      expectedRevision: revision, project: parsed.project, title: parsed.title,
      replacesProposalId: parsed.replacesProposalId, respondsTo: parsed.respondsTo,
    });
    adoptReviewState(result);
  } else {
    if (parsed.replacesProposalId) feedback = resolveFeedback(feedback, parsed.replacesProposalId, 'addressed', parsed.id);
    proposal = parsed;
  }
  reviewEpoch++;
  await cache();
  renderConnection(); openCompare();
}
function updateCompareSafety() {
  const active = proposal && currentComparison?.id === proposal.id;
  const stale = active && (dirty || currentComparison.baseRevision !== revision || !sameProject(currentComparison.baseProject, project));
  const requested = active && latestFeedback(feedback, proposal.id);
  const accepted = currentComparison?.id === comparison?.id;
  $('#compare-badge').textContent = !active ? accepted ? 'ACCEPTED SNAPSHOT' : 'SUPERSEDED' : requested ? 'CHANGES REQUESTED' : stale ? 'OUT OF DATE' : 'PROPOSAL';
  $('#accept-button').hidden = !active; $('#reject-button').hidden = !active;
  $('#request-changes-button').hidden = !active;
  $('#request-changes-button').disabled = conflict || reviewBusy || (bridge && !bridgeOnline);
  $('#request-changes-button').textContent = requested ? 'Add feedback' : 'Request changes';
  $('#reject-button').disabled = reviewBusy;
  $('#latest-proposal-button').hidden = !proposal || !!active;
  $('#latest-proposal-button').textContent = !$('#feedback-form').hidden && ($('#feedback-message').value.trim() || feedbackReference)
    ? 'Show latest (discard draft)' : 'Show latest proposal';
  $('#accept-button').disabled = !!requested || stale || conflict || reviewBusy || !$('#feedback-form').hidden || (bridge && !bridgeOnline);
  $('#compare-safety').textContent = requested
    ? 'Feedback saved. Ask your agent in chat to read it and revise.'
    : stale
    ? 'Your canvas changed. Ask the agent for a fresh proposal.'
    : active ? 'Nothing changes until you accept. Undo can restore your original.'
      : accepted ? 'Historical before/after snapshot; later edits are not shown here.' : 'This proposal was replaced or dismissed. Your canvas is unchanged.';
}
function openCompare() {
  clearFeedbackForm();
  currentComparison = clone(proposal || comparison);
  if (!currentComparison) {
    notify('No agent version yet. Prepare a handoff, then ask your agent to submit a drawing proposal.');
    return;
  }
  $('#compare-title').textContent = currentComparison.title;
  $('#compare-description').textContent = proposal
    ? `Based on saved revision ${currentComparison.baseRevision}. Compare the original snapshot with the agent's proposed version.`
    : 'Your last accepted proposal. Both versions are preserved as they were at acceptance.';
  const frameSelect = $('#compare-frame'); frameSelect.replaceChildren();
  const count = Math.max(currentComparison.baseProject.frames.length, currentComparison.project.frames.length);
  for (let i = 0; i < count; i++) frameSelect.add(new Option(String(i + 1), String(i)));
  frameSelect.value = String(Math.min(frameIndex, count - 1));
  compareMode = 'side'; renderCompare(); updateCompareSafety(); renderReviewHistory();
  if (!$('#compare-dialog').open) $('#compare-dialog').showModal();
}
function clearFeedbackForm() {
  $('#feedback-form').hidden = true;
  $('#feedback-form').reset();
  feedbackReference = null; feedbackProposalId = null;
  referenceRead++; referenceLoading = false;
  $('#submit-feedback').disabled = reviewBusy;
  $('#feedback-reference-preview').hidden = true;
  $('#feedback-reference-image').removeAttribute('src');
}
function requestChanges() {
  if (!proposal || currentComparison?.id !== proposal.id) throw new Error('Open the latest proposal to request changes.');
  if (feedbackProposalId !== proposal.id) clearFeedbackForm();
  feedbackProposalId = proposal.id;
  $('#feedback-form').hidden = false;
  $('#feedback-delivery-note').textContent = bridge
    ? 'This saves your note and image to the local bridge for the agent to read. It does not start or message an AI automatically. After saving, tell the agent in chat: "Read my review feedback."'
    : 'This saves your feedback and downloads a review packet. Share that JSON file with your agent, then import its revised proposal.';
  $('#submit-feedback').textContent = bridge ? 'Save feedback for agent' : 'Save & download request';
  updateCompareSafety();
  $('#feedback-message').focus();
  $('#feedback-form').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function reviewPacket() {
  return { format: 'spritecanvas-handoff', version: 1, revision, project, proposal, feedback };
}
function downloadReview() {
  downloadJson(reviewPacket(), `${safeName(project.name)}-review-handoff.json`);
}
function renderReviewHistory() {
  const entries = feedback.filter((entry) => entry.proposalId === currentComparison?.id || entry.addressedBy === currentComparison?.id);
  const key = [currentComparison?.id, ...entries.map((entry) => `${entry.id}:${entry.status}`)].join('|');
  if (key === feedbackRenderKey) return;
  feedbackRenderKey = key;
  const container = $('#review-history');
  container.replaceChildren(); container.hidden = !entries.length;
  for (const entry of entries) {
    const details = document.createElement('details'); details.className = 'review-entry';
    details.open = entry.status === 'open';
    const summary = document.createElement('summary');
    summary.textContent = `${entry.status === 'open' ? 'Changes requested' : entry.status === 'addressed' ? 'Addressed in this revision' : 'Dismissed request'} - ${entry.message.slice(0, 100)}`;
    const message = document.createElement('p'); message.textContent = entry.message;
    const caption = document.createElement('small');
    caption.textContent = `Saved ${new Date(entry.createdAt).toLocaleString()} against canvas revision ${entry.canvasRevision}.`;
    details.append(summary, message, caption);
    if (entry.reference) {
      const reference = document.createElement('div'); reference.className = 'reference-preview';
      const image = document.createElement('img');
      image.src = entry.reference.dataUrl; image.alt = 'Reference attached to this feedback';
      const link = document.createElement('a');
      link.href = entry.reference.dataUrl; link.download = entry.reference.name; link.textContent = entry.reference.name;
      reference.append(image, link); details.append(reference);
    }
    container.append(details);
  }
  if (entries.length) {
    const button = document.createElement('button');
    button.dataset.action = 'download-review'; button.textContent = 'Download review packet';
    container.append(button);
  }
}
async function submitFeedback() {
  if (reviewBusy) throw new Error('Feedback is already being saved.');
  if (referenceLoading) throw new Error('Wait for the reference image to finish loading.');
  await flushSave();
  if (reviewBusy) throw new Error('Feedback is already being saved.');
  if (!proposal || proposal.id !== feedbackProposalId) throw new Error('This proposal changed while you were writing. Your draft is still here; open the latest proposal before submitting it.');
  const entry = createFeedback(proposal, revision, { message: $('#feedback-message').value, reference: feedbackReference });
  reviewBusy = true; reviewEpoch++; updateCompareSafety();
  $$('#feedback-form input, #feedback-form textarea, #feedback-form button').forEach((control) => { control.disabled = true; });
  try {
    if (bridge) {
      adoptReviewState(await api('feedback', {
        expectedRevision: revision, proposalId: proposal.id, message: entry.message, reference: entry.reference,
      }));
    } else feedback = [...feedback, entry].slice(-MAX_FEEDBACK_ENTRIES);
    reviewEpoch++;
    await cache();
    clearFeedbackForm(); renderConnection();
    if (!bridge) downloadReview();
    notify(bridge
      ? 'Feedback saved for your agent. Tell it in chat: "Read my review feedback." Your canvas is unchanged.'
      : 'Review request saved and downloaded. Share the JSON with your agent; your canvas is unchanged.');
  } finally {
    reviewBusy = false;
    $$('#feedback-form input, #feedback-form textarea, #feedback-form button').forEach((control) => { control.disabled = false; });
    updateCompareSafety();
  }
}
function renderCompare() {
  if (!currentComparison) return;
  const before = currentComparison.baseProject, after = currentComparison.project;
  const index = Number($('#compare-frame').value) || 0;
  const beforeIndex = Math.min(index, before.frames.length - 1), afterIndex = Math.min(index, after.frames.length - 1);
  const diff = difference(before, after, index);
  renderPixels($('#before-canvas'), composite(before, beforeIndex), before.width, before.height);
  const canvas = $('#after-canvas');
  if (compareMode === 'diff') renderPixels(canvas, diff.pixels, diff.width, diff.height);
  else if (compareMode === 'wipe') {
    canvas.width = Math.max(before.width, after.width); canvas.height = Math.max(before.height, after.height);
    const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
    context.drawImage(projectCanvas(after, afterIndex), 0, 0);
    const split = Math.round(canvas.width * Number($('#wipe-slider').value) / 100);
    context.save(); context.beginPath(); context.rect(0, 0, split, canvas.height); context.clip();
    context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(projectCanvas(before, beforeIndex), 0, 0); context.restore();
    context.fillStyle = themeColor('--accent'); context.fillRect(split, 0, 1, canvas.height);
  } else renderPixels(canvas, composite(after, afterIndex), after.width, after.height);
  $('#before-figure').hidden = compareMode !== 'side';
  $('#compare-images').classList.toggle('single', compareMode !== 'side');
  $('#wipe-control').hidden = compareMode !== 'wipe';
  $('#after-label').textContent = compareMode === 'diff' ? 'Changed pixels in green' : compareMode === 'wipe' ? 'Your version / Agent version' : 'Agent proposal';
  $('#before-dimensions').textContent = `${before.width} x ${before.height}`;
  $('#after-dimensions').textContent = `${after.width} x ${after.height}`;
  $('#diff-count').textContent = `${diff.count.toLocaleString()} changed rendered pixel${diff.count === 1 ? '' : 's'} in frame ${index + 1}`;
  const details = [`Layers ${before.layers.length} -> ${after.layers.length}`, `Frames ${before.frames.length} -> ${after.frames.length}`];
  const paletteChanged = JSON.stringify(before.palette) !== JSON.stringify(after.palette);
  $('#palette-comparison').hidden = !paletteChanged;
  $('#before-palette-count').textContent = String(before.palette.length);
  $('#after-palette-count').textContent = String(after.palette.length);
  renderPaletteSwatches($('#before-palette'), paletteChanged ? before.palette : []);
  renderPaletteSwatches($('#after-palette'), paletteChanged ? after.palette : []);
  if (paletteChanged) details.push(`Palette ${before.palette.length} -> ${after.palette.length}`);
  if (before.frames[beforeIndex].duration !== after.frames[afterIndex].duration) details.push(`Timing ${before.frames[beforeIndex].duration} -> ${after.frames[afterIndex].duration} ms`);
  if (index >= before.frames.length || index >= after.frames.length) details.push('Missing frame: showing last available frame');
  $('#structure-changes').textContent = details.join(' / ');
  $$('[data-compare-mode]').forEach((button) => button.classList.toggle('active', button.dataset.compareMode === compareMode));
}
async function acceptProposal() {
  await flushSave();
  if (!proposal || currentComparison?.id !== proposal.id) throw new Error('This proposal is no longer available.');
  if (latestFeedback(feedback, proposal.id)) throw new Error('Changes were requested. Review the next revision before accepting.');
  if (proposal.baseRevision !== revision || !sameProject(proposal.baseProject, project)) throw new Error('The canvas changed since this proposal. Request a new one.');
  const before = clone(project);
  if (bridge) {
    const result = await api('accept', { expectedRevision: revision, proposalId: proposal.id });
    syncFromRemote(result);
  } else {
    comparison = { ...clone(proposal), acceptedAt: new Date().toISOString() };
    project = clone(proposal.project); proposal = null; revision++; dirty = false; changeSerial++;
  }
  historyPush(before); redoStack = []; selection = null; normalizeView();
  await cache(false); renderAll(); fitCanvas();
  $('#compare-dialog').close();
  notify('Agent version accepted. Compare versions keeps the before/after; Undo restores your previous canvas.');
}
async function rejectProposal() {
  if (!proposal || currentComparison?.id !== proposal.id) throw new Error('This proposal is no longer available.');
  await flushSave();
  if (bridge) {
    const result = await api('reject', { expectedRevision: revision, proposalId: proposal.id });
    adoptReviewState(result);
  } else {
    feedback = resolveFeedback(feedback, proposal.id, 'dismissed'); proposal = null;
  }
  await cache(); renderConnection(); $('#compare-dialog').close();
  notify('Proposal dismissed. Your canvas is unchanged.');
}
async function handoff() {
  await flushSave();
  if (dirty || conflict) throw new Error('Save or resolve your canvas first so the agent gets a consistent snapshot.');
  $('#handoff-description').textContent = bridge
    ? `Revision ${revision} is saved to the local bridge. Your agent can inspect the pixel data, render a PNG preview, and submit a proposal. Run from the SpriteCanvas repository:`
    : 'Download a snapshot and give it to your agent. Ask it to create a spritecanvas-proposal JSON with title, baseProject (unchanged from the handoff), and project (its edited version). Import the proposal here.';
  $('#handoff-command').textContent = bridge
    ? `npm run agent -- pull .spritecanvas\\handoff.json\nnpm run agent -- preview .spritecanvas\\preview.png\n\n# After drawing in a candidate JSON:\nnpm run agent -- propose .spritecanvas\\candidate.json --base ${revision} --title "My drawing changes"`
    : '{\n  "format": "spritecanvas-proposal",\n  "version": 1,\n  "title": "My drawing changes",\n  "baseProject": <original handoff.project>,\n  "project": <edited project; preserve project.id>\n}';
  $('#handoff-dialog').showModal();
}
async function loadFile(file) {
  if (file.size > 32 * 1024 * 1024) throw new Error('File exceeds the 32 MB import limit.');
  if (file.name.match(/\.(json|spritecanvas)$/i) || file.type.includes('json')) {
    const parsed = JSON.parse(await file.text());
    if (parsed.format === 'spritecanvas-proposal') { await importProposal(file); return; }
    setProject(validateProject(parsed.format === 'spritecanvas-handoff' ? parsed.project : parsed));
    notify('Project opened. Every layer and frame is editable; Undo returns to your previous project.');
    return;
  }
  if (!file.type.startsWith('image/')) throw new Error('Open a SpriteCanvas JSON project or a PNG, JPEG, WebP, or GIF image.');
  const bitmap = await createImageBitmap(file);
  if (importedImage) importedImage.bitmap.close();
  importedImage = { bitmap, name: file.name.replace(/\.[^.]+$/, '') };
  $('#image-description').textContent = `${file.name}: ${bitmap.width} x ${bitmap.height} pixels. The source image is not modified.`;
  $('#image-mode').value = 'layer';
  $('#image-width').value = project.width; $('#image-height').value = project.height;
  $('#image-width').disabled = true; $('#image-height').disabled = true;
  $('#image-dialog').showModal();
}
const actions = {
  new: () => $('#new-dialog').showModal(),
  open: () => $('#open-file').click(),
  save: downloadProject,
  export: () => $('#export-dialog').showModal(),
  help: () => $('#help-dialog').showModal(),
  undo, redo, fit: fitCanvas, 'zoom-in': () => setZoom(zoom + 1), 'zoom-out': () => setZoom(zoom - 1),
  copy: () => copyPixels(), paste: pastePixels,
  deselect: () => { selection = null; renderAll(); },
  'flip-x': () => { editable(); change(() => transformCel(cel(), project.width, project.height, 'flip-x', selection)); },
  'flip-y': () => { editable(); change(() => transformCel(cel(), project.width, project.height, 'flip-y', selection)); },
  rotate: () => { editable(); change(() => transformCel(cel(), project.width, project.height, 'rotate', selection)); },
  resize: () => { $('#resize-width').value = project.width; $('#resize-height').value = project.height; $('#resize-dialog').showModal(); },
  play,
  'add-frame': () => change(() => { const frame = addFrame(project); frameIndex = project.frames.indexOf(frame); selection = null; }),
  'duplicate-frame': () => change(() => { addFrame(project, frameIndex); frameIndex++; selection = null; }),
  'delete-frame': () => change(() => {
    if (project.frames.length === 1) throw new Error('Keep at least one frame.');
    project.frames.splice(frameIndex, 1); frameIndex = Math.max(0, frameIndex - 1); selection = null;
  }),
  'frame-left': () => change(() => {
    if (frameIndex > 0) { [project.frames[frameIndex], project.frames[frameIndex - 1]] = [project.frames[frameIndex - 1], project.frames[frameIndex]]; frameIndex--; }
  }),
  'frame-right': () => change(() => {
    if (frameIndex < project.frames.length - 1) { [project.frames[frameIndex], project.frames[frameIndex + 1]] = [project.frames[frameIndex + 1], project.frames[frameIndex]]; frameIndex++; }
  }),
  'add-layer': () => rename('Add a layer', 'New layer', (name) => change(() => { layerId = addLayer(project, name).id; })),
  'duplicate-layer': () => change(() => {
    const source = layer(), index = project.layers.indexOf(source);
    const added = addLayer(project, `${source.name.slice(0, 110)} copy`);
    for (const frame of project.frames) frame.cels[added.id] = [...frame.cels[source.id]];
    added.opacity = source.opacity; added.visible = source.visible;
    project.layers.splice(project.layers.indexOf(added), 1); project.layers.splice(index + 1, 0, added); layerId = added.id;
  }),
  'delete-layer': () => change(() => {
    if (project.layers.length === 1) throw new Error('Keep at least one layer.');
    if (layer().locked) throw new Error('Unlock the layer before deleting it.');
    const index = project.layers.findIndex((entry) => entry.id === layerId);
    for (const frame of project.frames) delete frame.cels[layerId];
    project.layers.splice(index, 1); layerId = project.layers[Math.max(0, index - 1)].id;
  }),
  'layer-up': () => change(() => {
    const index = project.layers.findIndex((entry) => entry.id === layerId);
    if (index < project.layers.length - 1) [project.layers[index], project.layers[index + 1]] = [project.layers[index + 1], project.layers[index]];
  }),
  'layer-down': () => change(() => {
    const index = project.layers.findIndex((entry) => entry.id === layerId);
    if (index > 0) [project.layers[index], project.layers[index - 1]] = [project.layers[index - 1], project.layers[index]];
  }),
  'merge-layer': () => change(() => {
    const index = project.layers.findIndex((entry) => entry.id === layerId);
    if (index === 0) throw new Error('There is no layer below this one.');
    const upper = layer(), lower = project.layers[index - 1];
    if (upper.locked || lower.locked) throw new Error('Unlock both layers before merging.');
    if (!upper.visible || !lower.visible) throw new Error('Make both layers visible before merging.');
    for (let i = 0; i < project.frames.length; i++) {
      const pixels = composite({ ...project, layers: [lower, upper] }, i);
      project.frames[i].cels[lower.id] = Array.from({ length: project.width * project.height }, (_, p) => fromRgba(...pixels.slice(p * 4, p * 4 + 4)));
      delete project.frames[i].cels[upper.id];
    }
    lower.opacity = 1; project.layers.splice(index, 1); layerId = lower.id;
  }),
  'add-color': () => change(() => {
    if (!foreground) throw new Error('Choose a non-transparent palette color.');
    if (project.palette.length >= 256) throw new Error('Palette has reached 256 colors.');
    if (!project.palette.includes(foreground)) project.palette.push(foreground);
  }),
  'swap-colors': () => { [foreground, background] = [background, foreground]; updateColor(); },
  'reference': async () => { setProject(await reference()); notify('Reference reconstruction opened as editable backdrop, border, and helmet layers. Undo restores your previous canvas.'); },
  handoff, compare: openCompare, accept: acceptProposal, reject: rejectProposal,
  'request-changes': requestChanges,
  'cancel-feedback': () => { clearFeedbackForm(); updateCompareSafety(); },
  'download-review': downloadReview,
  'remove-reference': () => {
    referenceRead++; referenceLoading = false; $('#submit-feedback').disabled = reviewBusy;
    feedbackReference = null; $('#feedback-reference').value = '';
    $('#feedback-reference-preview').hidden = true; $('#feedback-reference-image').removeAttribute('src');
  },
  'download-handoff': async () => {
    await flushSave();
    if (dirty || conflict) throw new Error('Resolve the local save conflict before handing off.');
    downloadJson(reviewPacket(), `${safeName(project.name)}-handoff.json`);
  },
  'import-proposal': () => $('#proposal-file').click(),
  reload: async () => {
    rename('Type LOAD to discard browser edits', '', async (answer) => {
      if (answer !== 'LOAD') throw new Error('Enter LOAD exactly to confirm. Your unsynced drawing has not been discarded.');
      stopPlayback(); syncFromRemote(await api('workspace'), true); await cache(false); fitCanvas();
    });
  },
};

for (const [id, name, key] of tools) {
  const button = document.createElement('button');
  button.dataset.tool = id; button.title = `${name} (${key})`;
  button.setAttribute('aria-label', `${name} (${key})`);
  button.innerHTML = `${icons(id)}<small>${key}</small>`; $('#tools').append(button);
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  guard(async () => {
    if (button.hasAttribute('data-close')) { button.closest('dialog').close(); return; }
    if (button.dataset.tool) { setTool(button.dataset.tool); return; }
    if (button.dataset.color) { foreground = color(button.dataset.color); updateColor(); return; }
    if (button.dataset.size) {
      $('#new-form').elements.width.value = button.dataset.size;
      $('#new-form').elements.height.value = button.dataset.size; return;
    }
    if (button.dataset.frame !== undefined) {
      stopPlayback(); frameIndex = Number(button.dataset.frame); selection = null; renderAll(); return;
    }
    if (button.dataset.compareMode) { compareMode = button.dataset.compareMode; renderCompare(); return; }
    if (button.dataset.layerAction) {
      const id = button.closest('[data-layer-id]').dataset.layerId;
      if (button.dataset.layerAction === 'select') {
        if (layerId !== id) { layerId = id; renderAll(); }
      }
      else change(() => {
        const target = project.layers.find((entry) => entry.id === id);
        if (button.dataset.layerAction === 'visibility') target.visible = !target.visible;
        else target.locked = !target.locked;
      });
      return;
    }
    if (button.dataset.action && actions[button.dataset.action]) await actions[button.dataset.action]();
  });
});
$('#layers').addEventListener('dblclick', (event) => {
  const name = event.target.closest('.layer-name');
  if (!name) return;
  const entry = project.layers.find((item) => item.id === name.closest('[data-layer-id]').dataset.layerId);
  rename('Rename layer', entry.name, (value) => change(() => {
    const current = project.layers.find((item) => item.id === entry.id);
    if (!current) throw new Error('This layer was removed while the rename dialog was open.');
    current.name = value;
  }));
});
$('#project-name').addEventListener('click', () => rename('Rename project', project.name, (value) => change(() => { project.name = value; })));
$('#text-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    const value = $('#text-input').value.trim();
    if (!value) throw new Error('Name cannot be empty.');
    await textCallback(value); $('#text-dialog').close();
  });
});
$('#new-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(() => {
    const fields = event.currentTarget.elements;
    setProject(createProject(Number(fields.width.value), Number(fields.height.value), fields.name.value.trim()));
    $('#new-dialog').close();
  });
});
$('#resize-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(() => {
    change(() => { resizeProject(project, Number($('#resize-width').value), Number($('#resize-height').value), $('#resize-center').checked); selection = null; });
    $('#resize-dialog').close(); fitCanvas();
  });
});
$('#export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(async () => {
    await exportProject(clone(project), {
      format: $('#export-format').value, frame: frameIndex,
      scale: integer(Number($('#export-scale').value), 1, 16, 'Scale'),
      columns: integer(Number($('#sheet-columns').value), 1, 64, 'Sheet columns'),
    });
    $('#export-dialog').close(); notify('Export downloaded. Sprite sheets also download a frame metadata JSON file.');
  });
});
$('#image-form').addEventListener('submit', (event) => {
  event.preventDefault();
  guard(() => {
    const isNew = $('#image-mode').value === 'project';
    const width = isNew ? integer(Number($('#image-width').value), 1, 256, 'Width') : project.width;
    const height = isNew ? integer(Number($('#image-height').value), 1, 256, 'Height') : project.height;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false;
    const bitmap = importedImage.bitmap;
    const ratio = Math.min(width / bitmap.width, height / bitmap.height);
    const dw = Math.max(1, Math.round(bitmap.width * ratio)), dh = Math.max(1, Math.round(bitmap.height * ratio));
    context.drawImage(bitmap, Math.floor((width - dw) / 2), Math.floor((height - dh) / 2), dw, dh);
    const data = context.getImageData(0, 0, width, height).data;
    change(() => {
      if (isNew) { project = createProject(width, height, importedImage.name.slice(0, 120) || 'Imported image'); frameIndex = 0; layerId = project.layers[0].id; }
      else layerId = addLayer(project, importedImage.name.slice(0, 120) || 'Imported image').id;
      project.frames[frameIndex].cels[layerId] = Array.from({ length: width * height }, (_, i) => fromRgba(...data.slice(i * 4, i * 4 + 4)));
      selection = null;
    });
    importedImage.bitmap.close(); importedImage = null; $('#image-dialog').close(); fitCanvas();
  });
});
$('#image-mode').addEventListener('change', () => {
  const fresh = $('#image-mode').value === 'project';
  $('#image-width').disabled = !fresh; $('#image-height').disabled = !fresh;
  if (fresh) {
    const ratio = Math.min(1, 256 / importedImage.bitmap.width, 256 / importedImage.bitmap.height);
    $('#image-width').value = Math.max(1, Math.round(importedImage.bitmap.width * ratio));
    $('#image-height').value = Math.max(1, Math.round(importedImage.bitmap.height * ratio));
  } else { $('#image-width').value = project.width; $('#image-height').value = project.height; }
});
$('#open-file').addEventListener('change', (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (file) guard(() => loadFile(file));
});
$('#proposal-file').addEventListener('change', (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (file) guard(() => importProposal(file));
});
$('#feedback-form').addEventListener('submit', (event) => { event.preventDefault(); guard(submitFeedback); });
$('#feedback-reference').addEventListener('change', (event) => {
  const file = event.target.files[0];
  const read = ++referenceRead;
  referenceLoading = false; $('#submit-feedback').disabled = reviewBusy;
  feedbackReference = null; $('#feedback-reference-preview').hidden = true;
  if (!file) return;
  guard(async () => {
    if (file.size > MAX_REFERENCE_BYTES) { event.target.value = ''; throw new Error('Reference image must be at most 2 MB.'); }
    referenceLoading = true; $('#submit-feedback').disabled = true;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the reference image.'));
        reader.readAsDataURL(file);
      });
      const reference = validateReference({ name: file.name, type: file.type, dataUrl });
      // Closing or replacing the form while FileReader runs must not attach
      // the old image to a different review.
      if (read !== referenceRead || $('#feedback-form').hidden || $('#feedback-reference').files[0] !== file) return;
      feedbackReference = reference;
      $('#feedback-reference-image').src = reference.dataUrl;
      $('#feedback-reference-name').textContent = reference.name;
      $('#feedback-reference-preview').hidden = false;
    } finally {
      if (read === referenceRead) { referenceLoading = false; $('#submit-feedback').disabled = reviewBusy; }
    }
  });
});
$('#foreground').addEventListener('input', (event) => { foreground = color(event.target.value); updateColor(); });
$('#background').addEventListener('input', (event) => { background = color(event.target.value); updateColor(); });
$('#hex-color').addEventListener('change', (event) => guard(() => { foreground = color(event.target.value); updateColor(); }));
$('#layer-opacity').addEventListener('change', (event) => guard(() => {
  if (layer().locked) throw new Error('Unlock the layer before changing opacity.');
  change(() => { layer().opacity = Number(event.target.value) / 100; });
}));
$('#layer-opacity').addEventListener('input', (event) => { $('#opacity-label').textContent = `${event.target.value}%`; });
$('#frame-duration').addEventListener('change', (event) => guard(() => change(() => { project.frames[frameIndex].duration = integer(Number(event.target.value), 20, 10000, 'Frame duration'); })));
$('#onion-toggle').addEventListener('change', renderCanvas);
$('#grid-toggle').addEventListener('click', () => { grid = !grid; $('#grid-toggle').setAttribute('aria-pressed', String(grid)); renderOverlay(); });
$('#mirror-x').addEventListener('click', () => { mirrorX = !mirrorX; $('#mirror-x').setAttribute('aria-pressed', String(mirrorX)); renderOverlay(); });
$('#mirror-y').addEventListener('click', () => { mirrorY = !mirrorY; $('#mirror-y').setAttribute('aria-pressed', String(mirrorY)); renderOverlay(); });
$('#wipe-slider').addEventListener('input', renderCompare);
$('#compare-frame').addEventListener('change', renderCompare);
overlay.addEventListener('pointerdown', (event) => guard(() => pointerDown(event)));
overlay.addEventListener('pointermove', pointerMove);
overlay.addEventListener('pointerup', () => finishStroke(false));
overlay.addEventListener('pointercancel', () => finishStroke(true));
overlay.addEventListener('lostpointercapture', () => { if (drag) finishStroke(true); });
overlay.addEventListener('pointerleave', () => { hover = null; if (!drag) renderOverlay(); });
overlay.addEventListener('contextmenu', (event) => event.preventDefault());
$('#palette').addEventListener('contextmenu', (event) => {
  const swatch = event.target.closest('[data-color]');
  if (swatch) { event.preventDefault(); background = color(swatch.dataset.color); updateColor(); }
});
stage.addEventListener('pointerdown', (event) => {
  if (event.target === overlay || !(spaceHeld || tool === 'hand' || event.button === 1)) return;
  guard(() => pointerDown(event));
});
stage.addEventListener('wheel', (event) => { event.preventDefault(); if (!drag) setZoom(zoom + (event.deltaY < 0 ? 1 : -1)); }, { passive: false });
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input,select,textarea,[contenteditable=true]') || $('dialog[open]')) return;
  const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
  if (key === ' ') { event.preventDefault(); spaceHeld = true; return; }
  if (drag) return;
  const handled = modifier ? ['s', 'z', 'y', 'c', 'x', 'v', 'a', 'd'].includes(key)
    : tools.some(([, , shortcut]) => shortcut.toLowerCase() === key) || ['g', 'x', '0', '+', '=', '-', '[', ']', 'delete', 'backspace', 'enter', 'escape', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key);
  if (!handled) return;
  event.preventDefault();
  guard(() => {
    if (modifier) {
      if (key === 's') downloadProject();
      if (key === 'z') event.shiftKey ? redo() : undo();
      if (key === 'y') redo();
      if (key === 'c') copyPixels();
      if (key === 'x') { editable(); copyPixels(true); }
      if (key === 'v') pastePixels();
      if (key === 'a') { selection = { x: 0, y: 0, w: project.width, h: project.height }; renderAll(); }
      if (key === 'd') { selection = null; renderAll(); }
      return;
    }
    const next = tools.find(([, , shortcut]) => shortcut.toLowerCase() === key);
    if (next) { setTool(next[0]); return; }
    if (key === 'g') $('#grid-toggle').click();
    if (key === 'x') actions['swap-colors']();
    if (key === '0') fitCanvas();
    if (key === '+' || key === '=') setZoom(zoom + 1);
    if (key === '-') setZoom(zoom - 1);
    if (key === '[' || key === ']') { $('#brush-size').value = Math.max(1, Math.min(32, brushSize() + (key === '[' ? -1 : 1))); renderOverlay(); }
    if (key === 'delete' || key === 'backspace') clearPixels();
    if (key === 'enter') play();
    if (key === 'escape') { selection = null; renderAll(); }
    if (key.startsWith('arrow')) {
      editable();
      const step = event.shiftKey ? 8 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      change(() => {
        const area = selection || { x: 0, y: 0, w: project.width, h: project.height };
        project.frames[frameIndex].cels[layerId] = movePixels(cel(), area, dx, dy);
        if (selection) selection = clippedArea(area, dx, dy);
      });
    }
  });
});
document.addEventListener('keyup', (event) => { if (event.key === ' ') spaceHeld = false; });
window.addEventListener('blur', () => { spaceHeld = false; if (drag) finishStroke(true); });
window.addEventListener('beforeunload', (event) => {
  const hasFeedbackDraft = !$('#feedback-form').hidden && ($('#feedback-message').value.trim() || feedbackReference);
  if (dirty || conflict || hasFeedbackDraft) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlayback(); if (dirty) guard(flushSave); } });
new ResizeObserver(() => { if (!drag) fitted ? fitCanvas() : renderCanvas(); }).observe(stage);

async function initialize() {
  let saved;
  try { db = await openStorage(); saved = await readStorage(db); }
  catch (error) { storageAvailable = false; notify(error.message, true); }
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const health = await api('health');
      bridge = health.service === 'spritecanvas'; bridgeOnline = bridge;
    } catch (error) {
      if (error.status !== 404) notify('No local bridge detected. Using browser-only mode; run npm start for live agent collaboration.');
    }
  }
  if (bridge) {
    const remote = await api('workspace');
    syncFromRemote(remote, true);
    if (saved?.bridge && saved.pending) {
      project = validateProject(saved.project); dirty = true;
      conflict = saved.revision !== remote.revision;
      revision = saved.revision;
      if (!conflict) scheduleSave();
      else notify('Recovered unsynced browser edits. Download them or explicitly load the disk version.', true);
    }
  } else if (saved) {
    project = validateProject(saved.project); revision = saved.revision;
    adoptReviewState(saved);
    // A lost bridge must not turn its unsynced recovery copy into a new static
    // document, otherwise reconnecting could silently replace those edits.
    bridge = !!saved.bridge;
    dirty = !!saved.pending;
    if (dirty) scheduleSave();
  } else project = createProject();
  frameIndex = 0; layerId = project.layers.at(-1).id;
  setTool('pencil'); updateColor(); renderAll(); fitCanvas();
  if (db) await cache(dirty);
  document.body.dataset.ready = 'true';
  if (new URLSearchParams(location.search).get('review') === '1' && proposal) openCompare();
  setInterval(() => { void poll(); }, 1800);
}
guard(initialize);
