import { uid } from './model.js';

export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
export const MAX_FEEDBACK_ENTRIES = 12;

export function validateReference(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 180) {
    throw new Error('A reference image needs a filename of 1-180 characters.');
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.type)) {
    throw new Error('Reference images must be PNG, JPEG, or WebP.');
  }
  const prefix = `data:${input.type};base64,`;
  if (typeof input.dataUrl !== 'string' || !input.dataUrl.startsWith(prefix)) throw new Error('Invalid reference image data.');
  const encoded = input.dataUrl.slice(prefix.length);
  if (encoded.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4) throw new Error('Reference image must be at most 2 MB.');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Reference image is not valid base64.');
  }
  const bytes = atob(encoded);
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw new Error('Reference image must be non-empty and at most 2 MB.');
  const signatures = {
    'image/png': bytes.startsWith('\x89PNG\r\n\x1a\n'),
    'image/jpeg': bytes.startsWith('\xFF\xD8\xFF'),
    'image/webp': bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP',
  };
  if (!signatures[input.type]) throw new Error('Reference image contents do not match its file type.');
  return { name: input.name, type: input.type, dataUrl: input.dataUrl };
}
export function createFeedback(proposal, revision, input) {
  if (!proposal) throw new Error('Open an active proposal before requesting changes.');
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.trim().length > 4000) {
    throw new Error('Describe the requested changes in 1-4,000 characters.');
  }
  return {
    id: uid(), proposalId: proposal.id, proposalTitle: proposal.title,
    proposalBaseRevision: proposal.baseRevision, canvasRevision: revision,
    message: input.message.trim(), reference: validateReference(input.reference),
    status: 'open', createdAt: new Date().toISOString(),
  };
}
export function latestFeedback(history, proposalId) {
  return history.findLast((entry) => entry.proposalId === proposalId && entry.status === 'open') || null;
}
function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}
export function replacementDetails(proposal, history, replacesProposalId, respondsTo) {
  if (!proposal) {
    if (replacesProposalId || respondsTo) conflict('The proposal to revise is no longer available. Pull the workspace again.');
    return {};
  }
  if (replacesProposalId !== proposal.id) conflict('An existing proposal needs review. A revision must explicitly identify the proposal it replaces.');
  const feedback = latestFeedback(history, proposal.id);
  if (!feedback) conflict('Request changes on the current proposal before replacing it, or dismiss it first.');
  if (respondsTo !== feedback.id) conflict('Review feedback changed. Read the latest feedback and respond to its exact ID.');
  return { replacesProposalId: proposal.id, respondsTo: feedback.id };
}
export function resolveFeedback(history, proposalId, status, addressedBy = null) {
  return history.map((entry) => entry.proposalId === proposalId && entry.status === 'open'
    ? { ...entry, status, addressedBy } : entry);
}
