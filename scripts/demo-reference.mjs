import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clone } from '../web/lib/model.js';
import { createReference } from './create-reference.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'http://127.0.0.1:4173';
async function request(route, body) {
  const response = await fetch(`${base}/api/${route}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpriteCanvas': '1' }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const state = await request('workspace');
if (state.revision !== 0 || state.proposal || state.project.frames.some((frame) => Object.values(frame.cels).some((pixels) => pixels.some(Boolean)))) {
  throw new Error('The demo only initializes a pristine workspace. Existing artwork was not changed. Use Open reference artwork instead.');
}
const candidate = createReference(state.project.id);
const baseline = clone(candidate);
baseline.name = 'Reference demo - blank stage';
baseline.frames[0].cels.helmet.fill(null);
const saved = await request('project', { expectedRevision: state.revision, project: baseline });
const workspace = path.join(root, '.spritecanvas');
mkdirSync(workspace, { recursive: true });
const candidateFile = path.join(workspace, 'reference-candidate.json');
writeFileSync(candidateFile, JSON.stringify(candidate));
function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'agent.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Agent command exited ${result.status}.`);
  process.stdout.write(result.stdout);
}
cli('pull', path.join(workspace, 'reference-handoff.json'));
cli('preview', path.join(workspace, 'reference-before.png'));
cli('propose', candidateFile, '--base', String(saved.revision), '--title', 'Reference reconstruction - golden helmet');
console.log('The background-only baseline and helmet proposal are BOTH agent-generated demo artwork, not user drawings.');
console.log('Review at http://127.0.0.1:4173/?review=1 . The proposal has not been accepted.');
