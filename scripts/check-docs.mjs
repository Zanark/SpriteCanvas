import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function sourceHash(name, data) {
  return sha256(/\.(?:js|mjs|json|css|html|svg|md)$/i.test(name)
    ? data.toString('utf8').replace(/\r\n/g, '\n') : data);
}

export function markdownParts(text) {
  const lines = text.split(/\r?\n/), prose = [], diagrams = [];
  let fence = null;
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && marker) {
      fence = { token: marker[1], language: marker[2].trim(), line: index + 1, body: [] };
    } else if (fence && marker && marker[1][0] === fence.token[0] && marker[1].length >= fence.token.length && !marker[2].trim()) {
      if (fence.language === 'mermaid') diagrams.push({ line: fence.line, body: fence.body.join('\n') });
      fence = null;
    } else if (fence) fence.body.push(line);
    else prose.push({ line: index + 1, text: line });
  }
  return { prose, diagrams, unclosedFence: fence?.line };
}

export function headingSlugs(text) {
  const slugs = new Set(), counts = new Map();
  for (const { text: line } of markdownParts(text).prose) {
    const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (!heading) continue;
    const slug = heading[1].replace(/<[^>]*>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const duplicate = counts.get(slug) || 0;
    counts.set(slug, duplicate + 1);
    slugs.add(duplicate ? `${slug}-${duplicate}` : slug);
  }
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/gi)) slugs.add(match[1]);
  return slugs;
}

export function markdownReferences(text) {
  const references = [];
  for (const { line, text: value } of markdownParts(text).prose) {
    for (const match of value.matchAll(/(!?)\[([^\]]*)\]\((<?[^\s)]+>?)(?:\s+["'][^"']*["'])?\)/g)) {
      references.push({ target: match[3].replace(/^<|>$/g, ''), image: !!match[1], label: match[2], line, html: false });
    }
    for (const match of value.matchAll(/<(img|a)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
      references.push({ target: match[2], image: match[1].toLowerCase() === 'img',
        label: match[0].match(/\balt=["']([^"']*)["']/i)?.[1] || '', line, html: true });
    }
  }
  return references;
}

export function sourceRange(fragment, lineCount) {
  const match = fragment.match(/^L(\d+)(?:-L(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2] || match[1]);
  return start >= 1 && end >= start && end <= lineCount;
}

export async function checkDocs() {
  const errors = [], imageReferences = new Set(), cache = new Map();
  const counts = { markdownFiles: 0, localLinks: 0, sourceRanges: 0, diagrams: 0, screenshots: 0, catalogueNodes: 0 };
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const fail = (file, message) => errors.push(`${relative(file)}: ${message}`);
  const inside = file => {
    const value = path.relative(root, file);
    return value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
  };
  const textOf = async file => {
    if (!cache.has(file)) cache.set(file, await readFile(file, 'utf8'));
    return cache.get(file);
  };
  const exists = async file => {
    try { return (await stat(file)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const documents = [path.join(root, 'README.md'), path.join(root, 'AGENTS.md')];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.md')) documents.push(file);
    }
  }
  await visit(path.join(root, 'docs'));
  for (const file of documents) {
    const text = await textOf(file), lines = text.split(/\r?\n/), parts = markdownParts(text);
    counts.markdownFiles++;
    if (parts.unclosedFence) fail(file, `Unclosed code fence at line ${parts.unclosedFence}.`);
    for (const diagram of parts.diagrams) {
      counts.diagrams++;
      if (!/\baccTitle\s*:/.test(diagram.body) || !/\baccDescr\s*[:{]/.test(diagram.body)) {
        fail(file, `Mermaid block at line ${diagram.line} needs accTitle and accDescr.`);
      }
    }
    for (const reference of markdownReferences(text)) {
      if (reference.image && !reference.label.trim()) fail(file, `Image at line ${reference.line} needs alt text.`);
      if (reference.image && !reference.html && !lines.slice(reference.line, reference.line + 5).some(line => /^\s*\*{0,2}Figure\s+\d/i.test(line))) {
        fail(file, `Image at line ${reference.line} needs an adjacent Figure caption.`);
      }
      if (/^(?:https?:|mailto:|data:)/i.test(reference.target)) continue;
      const [rawPath, rawFragment = ''] = reference.target.split('#');
      let localPath, fragment;
      try { localPath = decodeURIComponent(rawPath); fragment = decodeURIComponent(rawFragment); }
      catch (error) {
        if (!(error instanceof URIError)) throw error;
        fail(file, `Invalid URL encoding at line ${reference.line}: ${reference.target}`); continue;
      }
      const target = localPath ? path.resolve(path.dirname(file), localPath) : file;
      if (!inside(target)) { fail(file, `Link leaves the repository: ${reference.target}`); continue; }
      counts.localLinks++;
      if (!await exists(target)) { fail(file, `Missing link target at line ${reference.line}: ${reference.target}`); continue; }
      if (reference.image) imageReferences.add(relative(target));
      if (!fragment) continue;
      const content = await textOf(target), lineCount = content.replace(/\r?\n$/, '').split(/\r?\n/).length;
      const range = sourceRange(fragment, lineCount);
      if (range !== null) {
        counts.sourceRanges++;
        if (!range) fail(file, `Invalid source range: ${reference.target} (${lineCount} lines).`);
      } else if (target.endsWith('.md') && !headingSlugs(content).has(fragment)) {
        fail(file, `Missing heading anchor: ${reference.target}`);
      }
    }
  }
  const manifestFile = path.join(root, 'docs', 'assets', 'screenshots', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.kind !== 'real-ui-documentation-capture' || manifest.isolation.port !== 4373 ||
      manifest.isolation.privateWorkspaceRead !== false || manifest.isolation.externalRequests !== 0) {
    fail(manifestFile, 'Screenshot isolation/provenance contract changed; inspect the capture workflow.');
  }
  if (!manifest.fixtureSources.every(name => name.startsWith('web/'))) fail(manifestFile, 'Only bundled public fixtures may be used.');
  for (const [name, expected] of Object.entries(manifest.sourceHashes)) {
    const file = path.resolve(root, name);
    if (!inside(file)) { fail(manifestFile, `Source escapes repository: ${name}`); continue; }
    if (!await exists(file)) { fail(manifestFile, `Missing capture source: ${name}`); continue; }
    if (sourceHash(name, await readFile(file)) !== expected) fail(manifestFile, `Stale screenshot source ${name}; run npm run docs:screenshots.`);
  }
  for (const image of manifest.images) {
    counts.screenshots++;
    if (path.basename(image.file) !== image.file) { fail(manifestFile, `Invalid image path: ${image.file}`); continue; }
    const file = path.join(path.dirname(manifestFile), image.file), data = await readFile(file);
    if (sha256(data) !== image.sha256) fail(manifestFile, `Changed screenshot bytes: ${image.file}`);
    if (data.length < 24 || data.readUInt32BE(0) !== 0x89504E47 ||
        data.readUInt32BE(16) !== image.width || data.readUInt32BE(20) !== image.height) fail(manifestFile, `Invalid PNG dimensions: ${image.file}`);
    if (!image.caption?.trim()) fail(manifestFile, `Missing image caption: ${image.file}`);
    if (!imageReferences.has(relative(file))) fail(manifestFile, `Screenshot is not embedded in the book or README: ${image.file}`);
  }
  const catalogueFile = path.join(root, 'docs', 'catalogue.json');
  const catalogue = JSON.parse(await readFile(catalogueFile, 'utf8'));
  if (catalogue.items?.[0]?.title !== 'onboarding') fail(catalogueFile, 'Onboarding must be the first catalogue section.');
  async function checkNodes(nodes, depth) {
    if (!Array.isArray(nodes) || depth > 4 || nodes.length > 8) { fail(catalogueFile, 'Invalid catalogue depth or children count.'); return; }
    for (const node of nodes) {
      counts.catalogueNodes++;
      if (![node.title, node.name, node.prompt].every(value => typeof value === 'string' && value.trim())) fail(catalogueFile, 'Catalogue nodes need title, name and prompt.');
      const citations = [...String(node.prompt).matchAll(/([a-zA-Z0-9_./-]+\.(?:js|mjs|json|md|html|css|yml|yaml)):(\d+)/g)];
      if (!citations.length) fail(catalogueFile, `Missing source citation in ${node.title}.`);
      for (const [, name, number] of citations) {
        const file = path.resolve(root, name);
        if (!inside(file) || !await exists(file)) { fail(catalogueFile, `Missing cited file: ${name}`); continue; }
        if (Number(number) < 1 || Number(number) > (await textOf(file)).split(/\r?\n/).length) fail(catalogueFile, `Invalid cited line: ${name}:${number}`);
      }
      if (node.children?.length) await checkNodes(node.children, depth + 1);
      else if (!Array.isArray(node.children)) fail(catalogueFile, `Missing children array for ${node.title}.`);
    }
  }
  await checkNodes(catalogue.items, 1);
  if (errors.length) throw new Error(`Documentation checks failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  return counts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkDocs(), null, 2));
  console.log('Local links, source ranges, captioned captures and catalogue checked. Mermaid rendering and external URLs are not checked.');
}
