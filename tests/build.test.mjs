import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'spritecanvas-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'web', '.spritecanvas', '.agent-context']) mkdirSync(path.join(root, directory));
  cpSync(new URL('../scripts/build.mjs', import.meta.url), path.join(root, 'scripts', 'build.mjs'));
  writeFileSync(path.join(root, 'web', 'index.html'), '<canvas id="overlay-canvas"></canvas><script type="module" src="./app.js"></script>');
  writeFileSync(path.join(root, 'web', 'app.js'), 'export const studio = true;');
  writeFileSync(path.join(root, 'README.md'), '# Repository documentation stays here');
  writeFileSync(path.join(root, '.spritecanvas', 'workspace.json'), '{"fixture":true}');
  writeFileSync(path.join(root, '.agent-context', 'STATE.md'), 'Private fixture context');
  return root;
}

test('Pages build publishes web entry rather than README and records the deployed commit', t => {
  const root = fixture(t), commit = 'a'.repeat(40);
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { env: { ...process.env, GITHUB_SHA: commit } });
  assert.deepEqual(readdirSync(path.join(root, 'dist')).sort(), ['app.js', 'build-info.json', 'index.html']);
  assert.match(readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'), /overlay-canvas/);
  assert.match(readFileSync(path.join(root, 'README.md'), 'utf8'), /Repository documentation/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8')),
    { format: 'spritecanvas-site', version: 1, commit });
});

test('local builds do not invent a commit, and invalid deployment revisions fail before publishing', t => {
  const root = fixture(t), env = { ...process.env };
  delete env.GITHUB_SHA;
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { env });
  assert.equal(JSON.parse(readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8')).commit, null);
  rmSync(path.join(root, 'dist'), { recursive: true });
  assert.throws(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')],
    { env: { ...env, GITHUB_SHA: 'not-a-commit' }, stdio: 'pipe' }), /Command failed/);
  assert.equal(existsSync(path.join(root, 'dist')), false);
});
