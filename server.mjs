import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createProject, validateProject, clone, sameProject } from './web/lib/model.js';
import { createFeedback, latestFeedback, replacementDetails, resolveFeedback, MAX_FEEDBACK_ENTRIES } from './web/lib/review.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const port = Number(option('--port', process.env.PORT || 4173));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
const storage = path.resolve(option('--workspace', path.join(root, '.spritecanvas')));
const webRoot = path.join(root, 'web');
const statePath = path.join(storage, 'workspace.json');
const MAX_BODY = 32 * 1024 * 1024;
mkdirSync(storage, { recursive: true });
function persist(state) {
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), 'utf8');
  renameSync(temporary, statePath);
}
let state;
if (existsSync(statePath)) {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.feedback ??= [];
  state.project = validateProject(state.project);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Invalid workspace revision.');
  if (state.proposal) {
    state.proposal.baseProject = validateProject(state.proposal.baseProject);
    state.proposal.project = validateProject(state.proposal.project);
  }
  if (state.comparison) {
    state.comparison.baseProject = validateProject(state.comparison.baseProject);
    state.comparison.project = validateProject(state.comparison.project);
  }
} else {
  state = { revision: 0, project: createProject(50, 50, 'Untitled sprite'), proposal: null, comparison: null, feedback: [] };
  persist(state);
}
function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function commit(next) {
  persist(next);
  state = next;
}
function requireRevision(body) {
  if (!Number.isSafeInteger(body.expectedRevision)) fail(400, 'expectedRevision is required.');
  if (body.expectedRevision !== state.revision) fail(409, 'The canvas changed. Pull the latest workspace before saving or proposing.');
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
async function bodyJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json') || request.headers['x-spritecanvas'] !== '1') {
    fail(415, 'Use application/json and X-SpriteCanvas: 1.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Request exceeds 32 MB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail(400, 'Invalid JSON.');
  }
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const host = request.headers.host;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(host)) fail(403, 'This bridge only accepts loopback requests.');
    const url = new URL(request.url, `http://${host}`);
    // A clicked preview link may open the public studio shell, never an API or embedded resource.
    const studioNavigation = request.method === 'GET' &&
      ['/', '/index.html'].includes(url.pathname) &&
      request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document' &&
      request.headers['sec-fetch-user'] === '?1';
    if (request.headers.origin && request.headers.origin !== `http://${host}`) fail(403, 'Cross-origin access is not allowed.');
    if (request.headers['sec-fetch-site'] === 'cross-site' && !studioNavigation) fail(403, 'Cross-site access is not allowed.');
    if (url.pathname === '/api/workspace' && request.method === 'GET') return json(response, 200, state);
    if (url.pathname === '/api/health' && request.method === 'GET') return json(response, 200, { service: 'spritecanvas', version: 1 });
    if (url.pathname.startsWith('/api/') && request.method === 'POST') {
      const body = await bodyJson(request);
      if (!body || typeof body !== 'object') fail(400, 'Expected a JSON object.');
      requireRevision(body);
      if (url.pathname === '/api/project') {
        const project = validateProject(body.project);
        if (!sameProject(project, state.project)) commit({ ...state, project, revision: state.revision + 1 });
      } else if (url.pathname === '/api/proposals') {
        const replacement = replacementDetails(state.proposal, state.feedback, body.replacesProposalId, body.respondsTo);
        const project = validateProject(body.project);
        if (project.id !== state.project.id) fail(400, 'A proposal must preserve the current project ID.');
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 160) fail(400, 'A proposal needs a title of 1-160 characters.');
        const proposal = {
          id: randomUUID(), baseRevision: state.revision, baseProject: clone(state.project),
          project, title: body.title, createdAt: new Date().toISOString(), ...replacement,
        };
        const feedback = replacement.replacesProposalId
          ? resolveFeedback(state.feedback, replacement.replacesProposalId, 'addressed', proposal.id) : state.feedback;
        commit({ ...state, proposal, feedback });
      } else if (url.pathname === '/api/feedback') {
        if (!state.proposal || state.proposal.id !== body.proposalId) fail(409, 'This proposal is no longer available for feedback.');
        const entry = createFeedback(state.proposal, state.revision, body);
        commit({ ...state, feedback: [...state.feedback, entry].slice(-MAX_FEEDBACK_ENTRIES) });
      } else if (url.pathname === '/api/accept' || url.pathname === '/api/reject') {
        if (!state.proposal || state.proposal.id !== body.proposalId) fail(409, 'This proposal is no longer available.');
        if (url.pathname === '/api/accept') {
          if (latestFeedback(state.feedback, state.proposal.id)) fail(409, 'Changes were requested. Review a revised proposal before accepting.');
          if (state.proposal.baseRevision !== state.revision || !sameProject(state.proposal.baseProject, state.project)) {
            fail(409, 'Proposal is out of date. Ask the agent to create a new proposal on the latest canvas.');
          }
          const comparison = { ...state.proposal, acceptedAt: new Date().toISOString() };
          commit({ ...state, project: clone(state.proposal.project), revision: state.revision + 1, proposal: null, comparison });
        } else commit({ ...state, proposal: null, feedback: resolveFeedback(state.feedback, state.proposal.id, 'dismissed') });
      } else fail(404, 'Unknown API route.');
      return json(response, 200, state);
    }
    if (url.pathname.startsWith('/api/')) fail(404, 'Unknown API route.');
    if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Method not allowed.');
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { fail(400, 'Invalid URL encoding.'); }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) fail(403, 'Path not allowed.');
    const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
    const target = path.resolve(webRoot, relative);
    if (!target.startsWith(webRoot + path.sep)) fail(403, 'Path not allowed.');
    if (!existsSync(target) || !statSync(target).isFile()) fail(404, 'File not found.');
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : readFileSync(target));
  } catch (error) {
    const status = error.status || (error.code ? 500 : 400);
    if (status === 500) console.error(error);
    if (!response.headersSent) json(response, status, { error: status === 500 ? 'Workspace I/O failed. Your previous save was not replaced.' : error.message });
    else response.end();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`SpriteCanvas: http://127.0.0.1:${port}\nLocal workspace: ${statePath}\nOnly this loopback server exposes the collaboration API.`);
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
