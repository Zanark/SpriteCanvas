import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Emulate GitHub Pages' repository subpath, deliberately without a bridge API.
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1:4274').pathname;
  if (!pathname.startsWith('/SpriteCanvas/')) { response.writeHead(404); response.end(); return; }
  const relative = pathname.slice('/SpriteCanvas/'.length) || 'index.html';
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try {
    if (!statSync(filename).isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
    response.end(readFileSync(filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    response.writeHead(404); response.end();
  }
}).listen(4274, '127.0.0.1', () => console.log('Static Pages fixture: http://127.0.0.1:4274/SpriteCanvas/'));
