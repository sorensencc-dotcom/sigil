import crypto from 'node:crypto';

const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'financial_sensitive']);

function fail(message, details = {}) {
  throw Object.assign(new Error(message), { code: 'INVALID_PROVENANCE', details });
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${field} is required`, { field });
  return value.trim();
}

export function deriveIngressIdempotencyKey({ providerEventId, providerMessageId, inboxId } = {}) {
  const eventId = required(providerEventId, 'providerEventId');
  const messageId = required(providerMessageId, 'providerMessageId');
  const providerInboxId = required(inboxId, 'inboxId');
  const digest = crypto.createHash('sha256').update(`${eventId}\0${messageId}\0${providerInboxId}`, 'utf8').digest('hex');
  return `agentmail:${digest}`;
}

export function buildIngressProvenance(input = {}) {
  const providerEventId = required(input.providerEventId, 'providerEventId');
  const providerMessageId = required(input.providerMessageId, 'providerMessageId');
  const inboxId = required(input.inboxId, 'inboxId');
  const verifiedSender = required(input.verifiedSender, 'verifiedSender');
  const workflow = required(input.workflow, 'workflow');
  if (!CLASSIFICATIONS.has(input.classification)) fail('classification is invalid', { field: 'classification' });
  const receivedAt = required(input.receivedAt, 'receivedAt');
  if (!Number.isFinite(Date.parse(receivedAt))) fail('receivedAt must be an ISO date', { field: 'receivedAt' });
  const attachmentHashes = (input.attachmentHashes ?? []).map((attachment, index) => {
    if (!/^[a-f0-9]{64}$/.test(attachment?.sha256 ?? '') || typeof attachment.mediaType !== 'string' || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0) {
      fail(`attachmentHashes[${index}] is invalid`, { field: `attachmentHashes[${index}]` });
    }
    return { sha256: attachment.sha256, media_type: attachment.mediaType, byte_length: attachment.byteLength };
  });
  return {
    provider_event_id: providerEventId,
    provider_message_id: providerMessageId,
    inbox_id: inboxId,
    verified_sender: verifiedSender,
    workflow,
    classification: input.classification,
    attachment_hashes: attachmentHashes,
    received_at: receivedAt,
  };
}

export { CLASSIFICATIONS };
