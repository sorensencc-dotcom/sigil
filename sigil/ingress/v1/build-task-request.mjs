import crypto from 'node:crypto';
import { signedBytes } from '../../relay/v1/validate-envelope.mjs';

const CAPABILITY_PATTERN = /^sigil\.[a-z0-9_.-]+$/;
const SECRET_FIELDS = new Set(['body', 'raw_body', 'rawBody', 'api_key', 'apiKey', 'forwarding_token', 'forwardingToken', 'token', 'credential']);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_ENVELOPE', `${field} must be a non-empty string`, { field });
  return value.trim();
}

function keyForSigner(signer) {
  if (signer?.privateKey) return signer.privateKey;
  if (signer?.private_key_pem) return crypto.createPrivateKey(signer.private_key_pem);
  fail('INVALID_SIGNATURE', 'A signing private key is required');
}

function redactProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) fail('INVALID_ENVELOPE', 'Redacted provenance is required', { field: 'provenance' });
  for (const field of Object.keys(provenance)) if (SECRET_FIELDS.has(field)) fail('RAW_CONTENT_FORBIDDEN', `Provenance field ${field} cannot be placed in a trusted envelope`, { field });
  return JSON.parse(JSON.stringify(provenance));
}

export function buildTaskRequest({
  ingressEndpoint,
  ownerId,
  recipientEndpoint,
  taskId,
  conversationId = `conv_${crypto.randomUUID()}`,
  messageId = `msg_${crypto.randomUUID()}`,
  instruction,
  contextRefs = [],
  capabilities = [],
  provenance,
  idempotencyKey,
  correlationId = null,
  createdAt = new Date().toISOString(),
  expiresAt,
  signer,
  rawBody,
  broadcastScope,
} = {}) {
  if (rawBody !== undefined) fail('RAW_CONTENT_FORBIDDEN', 'Raw email bodies cannot enter envelope construction');
  if (ingressEndpoint?.endpoint_id !== 'ep_ingress') fail('ENDPOINT_SPOOFING', 'Ingress envelopes must be signed by ep_ingress');
  const effectiveOwner = requiredString(ownerId ?? ingressEndpoint?.owner_id, 'ownerId');
  if (ingressEndpoint.owner_id !== effectiveOwner) fail('ROUTE_NOT_AUTHORIZED', 'Ingress owner does not match the registered endpoint');
  if (!recipientEndpoint || typeof recipientEndpoint !== 'object') fail('INVALID_ENVELOPE', 'Exactly one recipient is required', { field: 'recipientEndpoint' });
  if (broadcastScope !== undefined) fail('INVALID_ENVELOPE', 'Ingress task requests cannot contain both recipient and broadcast scope');
  const recipientId = requiredString(recipientEndpoint.endpoint_id, 'recipientEndpoint.endpoint_id');
  const recipientOwner = requiredString(recipientEndpoint.owner_id, 'recipientEndpoint.owner_id');
  const task = requiredString(taskId, 'taskId');
  const text = requiredString(instruction, 'instruction');
  if (!Array.isArray(contextRefs) || !Array.isArray(capabilities)) fail('INVALID_ENVELOPE', 'contextRefs and capabilities must be arrays');
  if (capabilities.some((capability) => typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability))) fail('INVALID_ENVELOPE', 'Capabilities must use the registered sigil namespace', { field: 'capabilities' });
  const created = requiredString(createdAt, 'createdAt');
  const expires = requiredString(expiresAt, 'expiresAt');
  if (!Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.parse(created)) fail('INVALID_ENVELOPE', 'createdAt and expiresAt must be ordered ISO dates');
  const key = requiredString(idempotencyKey, 'idempotencyKey');
  const safeProvenance = redactProvenance(provenance);
  return signTaskRequest({
    protocol: 'sigil/1',
    message_id: requiredString(messageId, 'messageId'),
    conversation_id: requiredString(conversationId, 'conversationId'),
    message_type: 'task.request',
    sender: { owner_id: effectiveOwner, endpoint_id: 'ep_ingress', kind: 'agent' },
    recipient: { owner_id: recipientOwner, endpoint_id: recipientId },
    body: { task_id: task, instruction: text, provenance: safeProvenance },
    context_refs: JSON.parse(JSON.stringify(contextRefs)),
    capabilities: [...capabilities],
    correlation_id: correlationId,
    idempotency_key: key,
    expires_at: expires,
    created_at: created,
  }, signer);
}

export function signTaskRequest(envelope, signer) {
  if (!envelope || typeof envelope !== 'object' || envelope.signature) fail('INVALID_ENVELOPE', 'A new signature requires an unsigned envelope');
  const keyId = signer?.keyId ?? signer?.key_id;
  if (typeof keyId !== 'string' || keyId.trim() === '') fail('INVALID_SIGNATURE', 'A signing key id is required');
  const signature = crypto.sign(null, signedBytes(envelope), keyForSigner(signer)).toString('base64url');
  return { ...envelope, signature: { algorithm: 'Ed25519', key_id: keyId, value: signature } };
}
