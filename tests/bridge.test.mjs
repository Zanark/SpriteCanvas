import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { clone, addLayer, color, sameProject } from '../web/lib/model.js';
import { encodePng } from '../scripts/png.mjs';

let child, base, workspace;
async function request(route, body, headers = {}) {
  const response = await fetch(`${base}/api/${route}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpriteCanvas': '1', ...headers }, body: JSON.stringify(body),
  } : { headers });
  return { status: response.status, data: await response.json() };
}
function rawRequest(route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'spritecanvas-bridge-test-'));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs', '--port', String(port), '--workspace', workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 80; i++) {
    try { if ((await request('health')).status === 200) return; }
    catch (error) { if (error.name !== 'TypeError') throw error; }
    if (child.exitCode !== null) throw new Error(`Bridge failed: ${output}`);
    await delay(100);
  }
  throw new Error(`Bridge did not start: ${output}`);
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(); await exited;
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});
test('round trip: user saves, agent proposes, user compares and accepts', async () => {
  const initial = (await request('workspace')).data;
  const user = clone(initial.project);
  user.frames[0].cels[user.layers[0].id][51] = color('#123456');
  const saved = await request('project', { expectedRevision: initial.revision, project: user });
  assert.equal(saved.status, 200);
  const candidate = clone(saved.data.project);
  const layer = addLayer(candidate, 'Agent details');
  candidate.frames[0].cels[layer.id][52] = color('#FFAA00');
  const submitted = await request('proposals', { expectedRevision: saved.data.revision, project: candidate, title: 'Add highlights' });
  assert.equal(submitted.status, 200);
  assert.ok(sameProject(submitted.data.project, user));
  assert.ok(sameProject(submitted.data.proposal.baseProject, user));
  const duplicate = await request('proposals', { expectedRevision: saved.data.revision, project: candidate, title: 'Overwrite proposal' });
  assert.equal(duplicate.status, 409);
  const accepted = await request('accept', { expectedRevision: saved.data.revision, proposalId: submitted.data.proposal.id });
  assert.equal(accepted.status, 200);
  assert.ok(sameProject(accepted.data.project, candidate));
  assert.equal(accepted.data.proposal, null);
  assert.ok(sameProject(accepted.data.comparison.baseProject, user));
  assert.ok(sameProject(JSON.parse(readFileSync(path.join(workspace, 'workspace.json'), 'utf8')).project, candidate));
});
test('stale saves and proposals cannot overwrite a newer drawing', async () => {
  const state = (await request('workspace')).data;
  const candidate = clone(state.project);
  const submitted = await request('proposals', { expectedRevision: state.revision, project: candidate, title: 'Old proposal' });
  const newer = clone(state.project); newer.name = 'User keeps drawing';
  assert.equal((await request('project', { expectedRevision: state.revision, project: newer })).status, 200);
  const current = (await request('workspace')).data;
  assert.equal((await request('accept', { expectedRevision: current.revision, proposalId: submitted.data.proposal.id })).status, 409);
  assert.equal((await request('project', { expectedRevision: state.revision, project: candidate })).status, 409);
  assert.equal((await request('proposals', { expectedRevision: state.revision, project: candidate, title: 'Old base' })).status, 409);
  assert.ok(sameProject((await request('workspace')).data.project, newer));
  assert.equal((await request('reject', { expectedRevision: current.revision, proposalId: submitted.data.proposal.id })).status, 200);
});
test('API refuses invalid projects and protects loopback boundaries', async () => {
  const state = (await request('workspace')).data;
  assert.equal((await request('project', { expectedRevision: state.revision, project: {} })).status, 400);
  assert.equal((await request('project', { project: state.project })).status, 400);
  assert.equal((await request('project', { expectedRevision: state.revision, project: state.project }, { Origin: 'https://untrusted.example' })).status, 403);
  // Fetch normalizes Host; use a raw HTTP request to exercise host validation.
  assert.equal((await rawRequest('/api/workspace', { Host: 'untrusted.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/project`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/.spritecanvas/workspace.json`)).status, 403);
  assert.equal((await fetch(`${base}/.git/config`)).status, 403);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%5cserver.mjs`)).status, 403);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/lib/model.js`)).status, 200);
});

test('clicked cross-site studio navigation does not relax API, origin, host or embedding protection', async () => {
  const initial = (await request('workspace')).data;
  const navigation = {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1',
  };
  // Raw HTTP preserves Fetch Metadata headers that fetch itself can normalize.
  for (const route of ['/?review=1', '/index.html?review=1']) {
    const response = await rawRequest(route, navigation);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['content-type'], 'text/html');
    assert.match(response.body, /<!doctype html>/i);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const route of ['/api/workspace', '/api/health', '/lib/model.js', '/.spritecanvas/workspace.json']) {
    assert.equal((await rawRequest(route, navigation)).status, 403, route);
  }
  for (const route of ['/', '/api/project', '/api/accept']) {
    assert.equal((await rawRequest(route, navigation, 'POST')).status, 403, `POST ${route}`);
  }
  assert.equal((await rawRequest('/', navigation, 'HEAD')).status, 403);
  for (const headers of [
    { 'Sec-Fetch-Site': 'cross-site' },
    { ...navigation, 'Sec-Fetch-User': '?0' },
    { ...navigation, 'Sec-Fetch-Mode': 'cors' },
    { ...navigation, 'Sec-Fetch-Dest': 'iframe' },
    { ...navigation, 'Sec-Fetch-Dest': 'image' },
    { ...navigation, Origin: 'https://untrusted.example' },
    { ...navigation, Origin: 'null' },
    { ...navigation, Host: 'untrusted.example' },
  ]) assert.equal((await rawRequest('/', headers)).status, 403, JSON.stringify(headers));
  const current = (await request('workspace')).data;
  assert.equal(current.revision, initial.revision);
  assert.ok(sameProject(current.project, initial.project));
});

test('feedback is durable, blocks acceptance, and supports a guarded non-destructive revision', async () => {
  const initial = (await request('workspace')).data;
  const submitted = await request('proposals', { expectedRevision: initial.revision, project: initial.project, title: 'Please review' });
  const proposalId = submitted.data.proposal.id;
  const reference = { name: 'clean.png', type: 'image/png', dataUrl: `data:image/png;base64,${encodePng(initial.project).toString('base64')}` };
  assert.equal((await request('feedback', { expectedRevision: initial.revision, proposalId, message: '' })).status, 400);
  const requested = await request('feedback', { expectedRevision: initial.revision, proposalId, message: 'Replace the scribbles with a clean background.', reference });
  assert.equal(requested.status, 200);
  assert.equal(requested.data.revision, initial.revision);
  assert.ok(sameProject(requested.data.project, initial.project));
  assert.deepEqual(requested.data.proposal, submitted.data.proposal);
  assert.deepEqual(requested.data.feedback.at(-1).reference, reference);
  assert.equal((await request('accept', { expectedRevision: initial.revision, proposalId })).status, 409);
  const oldFeedback = requested.data.feedback.at(-1).id;
  const requestedAgain = await request('feedback', { expectedRevision: initial.revision, proposalId, message: 'Keep the ivory frame, too.' });
  const feedbackId = requestedAgain.data.feedback.at(-1).id;
  const candidate = clone(initial.project);
  for (const frame of candidate.frames) for (const pixels of Object.values(frame.cels)) pixels.fill(null);
  const payload = { expectedRevision: initial.revision, project: candidate, title: 'Clean composition', replacesProposalId: proposalId, respondsTo: oldFeedback };
  assert.equal((await request('proposals', payload)).status, 409);
  const revised = await request('proposals', { ...payload, respondsTo: feedbackId });
  assert.equal(revised.status, 200);
  assert.notEqual(revised.data.proposal.id, proposalId);
  assert.equal(revised.data.proposal.respondsTo, feedbackId);
  assert.ok(sameProject(revised.data.project, initial.project));
  assert.ok(sameProject(revised.data.proposal.baseProject, initial.project));
  assert.equal(revised.data.feedback.at(-1).status, 'addressed');
  assert.equal((await request('feedback', { expectedRevision: initial.revision, proposalId, message: 'Late note on the old version' })).status, 409);
  const onDisk = JSON.parse(readFileSync(path.join(workspace, 'workspace.json'), 'utf8'));
  assert.deepEqual(onDisk.feedback, revised.data.feedback);
  const accepted = await request('accept', { expectedRevision: initial.revision, proposalId: revised.data.proposal.id });
  assert.equal(accepted.status, 200);
  assert.ok(sameProject(accepted.data.project, candidate));
});
