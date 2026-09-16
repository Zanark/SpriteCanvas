import test from 'node:test';
import assert from 'node:assert/strict';
import { headingSlugs, markdownParts, markdownReferences, sourceRange, sourceHash } from '../scripts/check-docs.mjs';

test('documentation links exclude code examples but include images and HTML assets', () => {
  const input = '# Guide\n[Source](../web/app.js#L1-L2)\n![Studio](assets/studio.png)\n<img src="logo.png" alt="Logo">\n```js\n[not a link](missing.md)\n```\n';
  const references = markdownReferences(input);
  assert.deepEqual(references.map(({ target, image, label }) => ({ target, image, label })), [
    { target: '../web/app.js#L1-L2', image: false, label: 'Source' },
    { target: 'assets/studio.png', image: true, label: 'Studio' },
    { target: 'logo.png', image: true, label: 'Logo' },
  ]);
});

test('documentation heading anchors preserve repeated-heading suffixes and ignore fenced headings', () => {
  const text = '# Project format / offline collaboration\n## A `cel`\n## A `cel`\n```\n# Hidden\n```\n<a id="manual"></a>';
  assert.deepEqual([...headingSlugs(text)], ['project-format--offline-collaboration', 'a-cel', 'a-cel-1', 'manual']);
});

test('source range validation catches reversed, zero and out-of-bounds citations', () => {
  assert.equal(sourceRange('L1-L10', 10), true);
  assert.equal(sourceRange('L10', 10), true);
  assert.equal(sourceRange('L0', 10), false);
  assert.equal(sourceRange('L10-L2', 10), false);
  assert.equal(sourceRange('L11', 10), false);
  assert.equal(sourceRange('heading', 10), null);
});

test('documentation fence parsing retains Mermaid metadata and reports unclosed fences', () => {
  const complete = markdownParts('```mermaid\nflowchart LR\n accTitle: Example\n accDescr: An example.\n A --> B\n```\nText');
  assert.equal(complete.diagrams.length, 1);
  assert.match(complete.diagrams[0].body, /accTitle: Example/);
  assert.deepEqual(complete.prose, [{ line: 7, text: 'Text' }]);
  assert.equal(complete.unclosedFence, undefined);
  assert.equal(markdownParts('text\n~~~json\n{}').unclosedFence, 2);
});

test('capture source fingerprints tolerate checkout line endings but preserve binary bytes', () => {
  assert.equal(sourceHash('web/app.js', Buffer.from('a\r\nb\r\n')), sourceHash('web/app.js', Buffer.from('a\nb\n')));
  assert.notEqual(sourceHash('logo.png', Buffer.from('a\r\nb')), sourceHash('logo.png', Buffer.from('a\nb')));
});
