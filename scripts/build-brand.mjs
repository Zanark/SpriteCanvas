import { readFile, writeFile } from 'node:fs/promises';
import { brandAssets } from './brand.mjs';

const source = JSON.parse(await readFile(new URL('../web/assets/spritecanvas-logo.spritecanvas.json', import.meta.url), 'utf8'));
const { svg, png, faviconSvg } = brandAssets(source);
await Promise.all([
  writeFile(new URL('../web/assets/spritecanvas-logo.svg', import.meta.url), svg),
  writeFile(new URL('../web/assets/spritecanvas-logo.png', import.meta.url), png),
  writeFile(new URL('../web/favicon.svg', import.meta.url), faviconSvg),
]);
console.log('Generated the camera-facing logo with flare, 32x README PNG and flare-free favicon.');
