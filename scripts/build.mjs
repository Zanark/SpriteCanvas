import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
cpSync(new URL('../web/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
console.log(`Static site ready in ${root}dist (no server or private workspace included).`);
