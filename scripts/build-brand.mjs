import { readFile, writeFile } from 'node:fs/promises';
import { brandAssets } from './brand.mjs';
import { idleBrandAssets } from './brand-idle.mjs';

const [source, idle] = await Promise.all(['spritecanvas-logo.spritecanvas.json', 'spritecanvas-logo-idle.spritecanvas.json']
  .map(async name => JSON.parse(await readFile(new URL(`../web/assets/${name}`, import.meta.url), 'utf8'))));
const { svg, png, faviconSvg } = brandAssets(source);
const { gif } = idleBrandAssets(idle);
await Promise.all([
  writeFile(new URL('../web/assets/spritecanvas-logo.svg', import.meta.url), svg),
  writeFile(new URL('../web/assets/spritecanvas-logo.png', import.meta.url), png),
  writeFile(new URL('../web/favicon.svg', import.meta.url), faviconSvg),
  writeFile(new URL('../web/assets/spritecanvas-logo-idle.gif', import.meta.url), gif),
]);
console.log('Generated camera-facing SVG/PNG, flare-free favicon and the 16x README idle GIF.');
