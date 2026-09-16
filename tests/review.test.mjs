import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../web/lib/model.js';
import { createFeedback, latestFeedback, replacementDetails, resolveFeedback, validateReference, MAX_REFERENCE_BYTES } from '../web/lib/review.js';
import { encodePng } from '../scripts/png.mjs';

const proposal = { id: 'proposal-1', title: 'Helmet on scribbles', baseRevision: 6 };
const reference = {
  name: 'reference.png', type: 'image/png',
  dataUrl: `data:image/png;base64,${encodePng(createProject(2, 2)).toString('base64')}`,
};
test('feedback preserves review identity, latest canvas revision, message and reference', () => {
  const entry = createFeedback(proposal, 9, { message: '  Clear the background and match this reference.  ', reference });
  assert.equal(entry.proposalId, proposal.id);
  assert.equal(entry.proposalBaseRevision, 6);
  assert.equal(entry.canvasRevision, 9);
  assert.equal(entry.status, 'open');
  assert.equal(entry.message, 'Clear the background and match this reference.');
  assert.deepEqual(entry.reference, reference);
  assert.throws(() => createFeedback(proposal, 9, { message: ' ' }), /Describe/);
  assert.throws(() => createFeedback(proposal, 9, { message: 'a'.repeat(4001) }), /Describe/);
});
test('reference validation rejects active content, mismatched MIME and oversized data', () => {
  assert.equal(validateReference(null), null);
  assert.throws(() => validateReference({ ...reference, type: 'image/svg+xml' }), /PNG, JPEG/);
  assert.throws(() => validateReference({ ...reference, dataUrl: 'https://example.com/image.png' }), /Invalid/);
  assert.throws(() => validateReference({ ...reference, dataUrl: 'data:image/png;base64,a===' }), /base64/);
  assert.throws(() => validateReference({ ...reference, dataUrl: 'data:image/png;base64,aGVsbG8=' }), /contents/);
  const large = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
  assert.throws(() => validateReference({ ...reference, dataUrl: `data:image/png;base64,${large.toString('base64')}` }), /2 MB/);
  const supported = Buffer.alloc(MAX_REFERENCE_BYTES);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(supported);
  assert.ok(validateReference({ ...reference, dataUrl: `data:image/png;base64,${supported.toString('base64')}` }));
});
test('revisions must address the exact latest feedback for the exact current proposal', () => {
  const first = createFeedback(proposal, 9, { message: 'Clear the scribbles.' });
  const second = createFeedback(proposal, 9, { message: 'Also keep the frame.' });
  assert.deepEqual(replacementDetails(null, [], null, null), {});
  assert.throws(() => replacementDetails(null, [], proposal.id, first.id), /no longer available/);
  assert.throws(() => replacementDetails(proposal, [], proposal.id, first.id), /Request changes/);
  assert.throws(() => replacementDetails(proposal, [first], 'other-proposal', first.id), /explicitly/);
  assert.throws(() => replacementDetails(proposal, [first, second], proposal.id, first.id), /feedback changed/);
  assert.deepEqual(replacementDetails(proposal, [first, second], proposal.id, second.id), { replacesProposalId: proposal.id, respondsTo: second.id });
  assert.equal(latestFeedback([first, second], proposal.id).id, second.id);
  const resolved = resolveFeedback([first, second], proposal.id, 'addressed', 'proposal-2');
  assert.equal(latestFeedback(resolved, proposal.id), null);
  assert.equal(resolved[0].addressedBy, 'proposal-2');
  assert.equal(first.status, 'open');
});
