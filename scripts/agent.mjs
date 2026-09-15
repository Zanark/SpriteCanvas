import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { validateProject, applyOperations } from '../web/lib/model.js';
import { validateReference } from '../web/lib/review.js';
import { encodePng } from './png.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = option('--url', 'http://127.0.0.1:4173');
const url = new URL(base);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('The agent CLI only connects to a loopback HTTP bridge.');
async function request(route, body) {
  const response = await fetch(new URL(route, url), body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpriteCanvas': '1' }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
const [command = 'status', filename] = args;
if (!['status', 'pull', 'preview', 'propose', 'apply', 'feedback'].includes(command)) {
  throw new Error('Usage: agent status | pull <handoff.json> | feedback [output-directory] | preview <image.png> | propose <project.json> --base N --title "..." [--replace proposal-id --respond-to feedback-id] | apply <operations.json> --base N --title "..."');
}
const state = await request('/api/workspace');
const feedbackSummary = (entry) => ({
  ...entry,
  reference: entry.reference ? { name: entry.reference.name, type: entry.reference.type } : null,
});
if (command === 'status') {
  console.log(JSON.stringify({
    revision: state.revision, name: state.project.name, width: state.project.width, height: state.project.height,
    layers: state.project.layers, frames: state.project.frames.map(({ id, duration }) => ({ id, duration })),
    proposal: state.proposal ? { id: state.proposal.id, title: state.proposal.title, baseRevision: state.proposal.baseRevision } : null,
    feedback: (state.feedback || []).filter((entry) => entry.proposalId === state.proposal?.id).map(feedbackSummary),
  }, null, 2));
} else if (command === 'pull') {
  if (!filename || filename.startsWith('--')) throw new Error('Specify an output JSON file.');
  writeFileSync(filename, JSON.stringify({
    format: 'spritecanvas-handoff', version: 1, revision: state.revision,
    project: state.project, proposal: state.proposal, feedback: state.feedback || [],
  }, null, 2));
  console.log(`Saved revision ${state.revision} to ${filename}. Keep this snapshot as your proposal base.`);
} else if (command === 'feedback') {
  const feedback = state.feedback || [];
  const summary = feedback.map(feedbackSummary);
  if (filename && !filename.startsWith('--')) {
    const folder = path.resolve(filename);
    mkdirSync(folder, { recursive: true });
    for (let index = 0; index < feedback.length; index++) {
      const reference = validateReference(feedback[index].reference);
      if (!reference) continue;
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[reference.type];
      const target = path.join(folder, `reference-${index + 1}.${extension}`);
      writeFileSync(target, Buffer.from(reference.dataUrl.split(',')[1], 'base64'));
      summary[index].reference.file = target;
    }
    writeFileSync(path.join(folder, 'feedback.json'), JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
} else if (command === 'preview') {
  if (!filename || filename.startsWith('--')) throw new Error('Specify an output PNG file.');
  writeFileSync(filename, encodePng(state.project, 0, 8));
  console.log(`Rendered current canvas to ${filename}.`);
} else {
  if (!filename || filename.startsWith('--')) throw new Error('Specify an input JSON file.');
  const rawRevision = option('--base', null);
  if (rawRevision === null) throw new Error('--base <revision from your handoff> is required. Never guess a revision.');
  const expectedRevision = Number(rawRevision);
  if (expectedRevision !== state.revision) throw new Error(`Stale base ${expectedRevision}; current canvas is revision ${state.revision}. Pull again before drawing.`);
  const input = JSON.parse(readFileSync(filename, 'utf8'));
  const project = command === 'apply' ? applyOperations(state.project, input) : validateProject(input.project || input);
  const result = await request('/api/proposals', {
    expectedRevision, project, title: option('--title', input.title || 'Agent drawing proposal'),
    replacesProposalId: option('--replace', input.replacesProposalId || null),
    respondsTo: option('--respond-to', input.respondsTo || null),
  });
  console.log(`Proposal submitted: ${result.proposal.id}. The user can compare, accept, or dismiss it. Their canvas is unchanged.`);
}
