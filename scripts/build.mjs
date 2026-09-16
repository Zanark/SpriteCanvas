import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = process.env.GITHUB_SHA ?? null;
if (commit !== null && !/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('GITHUB_SHA must be a full 40-character Git commit.');
}
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
cpSync(new URL('../web/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/build-info.json', import.meta.url), JSON.stringify({
  format: 'spritecanvas-site', version: 1, commit,
}, null, 2) + '\n');
console.log(`Static site ready in ${root}dist (no server or private workspace included).`);
