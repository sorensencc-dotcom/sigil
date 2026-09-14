import crypto from 'node:crypto';
import { resolveInboxMapping } from './agentmail-config.mjs';
import { buildIngressProvenance, deriveIngressIdempotencyKey } from './agentmail-provenance.mjs';
import { buildTaskRequest } from './build-task-request.mjs';
import { classifyInboundMessage } from './classify.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const STATUS_BY_CODE = Object.freeze({
  WEBHOOK_SIGNATURE_INVALID: 401,
  SENDER_NOT_ALLOWLISTED: 403,
  UNKNOWN_INBOX: 400,
  MULTIPLE_INBOX_MAPPING: 409,
  INVALID_FORWARDING_TOKEN: 400,
  UNKNOWN_WORKFLOW: 400,
  TOKEN_MISMATCH: 403,
  IRON_EXTERNAL_MAIL_REJECTED: 403,
  FINANCIAL_APPROVAL_REQUIRED: 403,
  QUEUE_SATURATED: 429,
  AGENTMAIL_PROVIDER_TIMEOUT: 504,
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function safeResponse(error) {
  const code = error?.code ?? 'AGENTMAIL_INGRESS_REJECTED';
  return { status: STATUS_BY_CODE[code] ?? 400, body: { code, message: publicMessage(code), details: {} } };
}

function publicMessage(code) {
  return ({
    WEBHOOK_SIGNATURE_INVALID: 'Webhook authenticity could not be verified',
    SENDER_NOT_ALLOWLISTED: 'Sender is not authorized for AgentMail ingress',
    UNKNOWN_INBOX: 'AgentMail inbox is not registered',
    MULTIPLE_INBOX_MAPPING: 'AgentMail inbox mapping is ambiguous',
    INVALID_FORWARDING_TOKEN: 'Forwarding token is invalid',
    UNKNOWN_WORKFLOW: 'Workflow alias is not configured',
    TOKEN_MISMATCH: 'Forwarding token does not match workflow alias',
    IRON_EXTERNAL_MAIL_REJECTED: 'External mail is not accepted by the iron endpoint',
    FINANCIAL_APPROVAL_REQUIRED: 'Financial-sensitive handling requires explicit approval',
    QUEUE_SATURATED: 'Ingress queue is saturated',
    AGENTMAIL_PROVIDER_TIMEOUT: 'AgentMail provider timed out',
  })[code] ?? 'AgentMail message was rejected';
}

function tokenRecord(tokenStore, alias) {
  if (tokenStore instanceof Map) return tokenStore.get(alias);
  return tokenStore?.[alias];
}

export function resolveWorkflow(address, tokenStore = {}) {
  if (typeof address !== 'string' || address.trim() === '') fail('INVALID_FORWARDING_TOKEN', 'Forwarding address is required');
  const localPart = address.trim().split('@', 1)[0];
  const parts = localPart.split('+');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !TOKEN_PATTERN.test(parts[2])) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address does not match the required grammar');
  const alias = `${parts[0]}+${parts[1]}`;
  const configured = tokenRecord(tokenStore, alias);
  if (!configured) fail('UNKNOWN_WORKFLOW', 'Workflow alias is not configured');
  const expectedToken = typeof configured === 'string' ? configured : configured.token;
  const expectedWorkflow = typeof configured === 'object' ? configured.workflow : parts[1];
  if (typeof expectedToken !== 'string' || !TOKEN_PATTERN.test(expectedToken)) fail('INVALID_FORWARDING_TOKEN', 'Configured forwarding token is invalid');
  if (expectedWorkflow && expectedWorkflow !== parts[1]) fail('TOKEN_MISMATCH', 'Forwarding token workflow mismatch');
  if (parts[2].length !== expectedToken.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expectedToken))) fail('TOKEN_MISMATCH', 'Forwarding token workflow mismatch');
  return { alias, endpointAlias: parts[0], workflow: parts[1] };
}

function exactSenderAllowed(event, policy) {
  const sender = String(event.from ?? event.sender?.email ?? '').trim().toLowerCase();
  const allowlist = (policy.senderAllowlist ?? []).map((value) => String(value).trim().toLowerCase());
  const authenticated = event.authenticatedSender === true && Boolean(event.senderAuthentication);
  return authenticated && allowlist.includes(sender);
}

function eventValue(event, names) {
  for (const name of names) if (event?.[name] !== undefined) return event[name];
  return undefined;
}

async function quarantineAttachments(event, quarantine) {
  const results = [];
  for (const attachment of event.attachments ?? []) {
    const stream = attachment.stream ?? attachment.content;
    if (stream === undefined) fail('INVALID_ATTACHMENT', 'Attachment content is unavailable');
    results.push(await quarantine(stream, { ...attachment, ...(attachment.metadata ?? {}) }));
  }
  return results;
}

export async function handleAgentMailWebhook({ rawBody, headers, inboxId, provider, registry, ingress, ledger, policy = {}, quarantine = async () => null, enqueue, clock = () => new Date() } = {}) {
  let event;
  try {
    event = await provider?.verifyWebhook?.({ rawBody, headers });
    if (!event || typeof event !== 'object') fail('WEBHOOK_SIGNATURE_INVALID', 'Webhook authenticity could not be verified');
    const mapping = registry?.resolveInboxMapping
      ? registry.resolveInboxMapping(inboxId)
      : resolveInboxMapping(registry?.inboxMappings, inboxId);
    const sender = String(event.from ?? event.sender?.email ?? '').trim().toLowerCase();
    if (!exactSenderAllowed(event, policy)) fail('SENDER_NOT_ALLOWLISTED', 'Sender is not authorized for AgentMail ingress');
    if (mapping.endpointId === 'ep_iron' && (event.external === true || event.sender?.internal !== true)) fail('IRON_EXTERNAL_MAIL_REJECTED', 'External mail is not accepted by the iron endpoint');
    const workflow = resolveWorkflow(event.alias ?? event.to, policy.forwardingTokens ?? {});
    if (!mapping.workflowPolicy.includes(workflow.workflow)) fail('TOKEN_MISMATCH', 'Workflow is not allowed for this inbox');
    const providerEventId = String(event.eventId ?? event.id ?? '');
    const providerMessageId = String(event.messageId ?? event.message_id ?? '');
    const derivedKey = deriveIngressIdempotencyKey({ providerEventId, providerMessageId, inboxId });
    const existing = await ledger?.recordIngressEvent?.({ eventId: providerEventId, providerEventId, providerMessageId, inboxId, idempotencyKey: derivedKey, state: 'received' });
    if (existing?.duplicate || (existing?.state && existing.state !== 'received')) return { status: 202, eventId: providerEventId, state: existing.state, duplicate: true };
    const now = clock() instanceof Date ? clock() : new Date(clock());
    const attachmentResults = await quarantineAttachments(event, quarantine);
    await ledger?.transitionIngressState?.(providerEventId, 'quarantined');
    const classification = classifyInboundMessage({ sender: { email: sender, internal: event.sender?.internal === true }, workflow: workflow.workflow, body: String(event.body ?? ''), attachments: event.attachments ?? [] });
    if (classification.classification === 'financial_sensitive' && policy.allowFinancialLocalOnly !== true) fail('FINANCIAL_APPROVAL_REQUIRED', 'Financial-sensitive handling requires explicit approval');
    const provenance = buildIngressProvenance({
      providerEventId, providerMessageId, inboxId, verifiedSender: sender, workflow: workflow.workflow,
      classification: classification.classification,
      attachmentHashes: attachmentResults.filter(Boolean), receivedAt: now.toISOString(),
    });
    if (mapping.endpointId === 'ep_judgment') {
      await ledger?.transitionIngressState?.(providerEventId, 'quarantined');
      return { status: 202, eventId: providerEventId, state: 'quarantined', classification: classification.classification };
    }
    if (typeof enqueue !== 'function') fail('QUEUE_UNAVAILABLE', 'Ingress queue is unavailable');
    const conversationId = event.conversationId ?? `conv_${crypto.randomUUID()}`;
    const contextRefs = attachmentResults.filter(Boolean).map((attachment) => ({ scope: `scope:conversation/${conversationId}`, reference: attachment.reference, sha256: attachment.sha256 }));
    const instruction = await policy.normalizeInstruction?.(event) ?? event.sanitizedInstruction ?? event.normalizedText ?? event.body;
    const capabilities = policy.capabilitiesByEndpoint?.[mapping.endpointId] ?? policy.capabilities ?? [];
    const envelope = buildTaskRequest({
      ingressEndpoint: ingress.endpoint,
      ownerId: ingress.ownerId,
      recipientEndpoint: { endpoint_id: mapping.endpointId, owner_id: policy.recipientOwners?.[mapping.endpointId] ?? ingress.ownerId },
      taskId: event.taskId ?? `task_${providerMessageId || crypto.randomUUID()}`,
      conversationId,
      instruction,
      contextRefs,
      capabilities,
      provenance,
      idempotencyKey: derivedKey,
      correlationId: `corr_${providerEventId}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      signer: ingress.signer,
    });
    await ledger?.transitionIngressState?.(providerEventId, 'accepted');
    try {
      await enqueue(envelope, { localOnly: classification.policy.localOnly, workflow: workflow.workflow });
    } catch (error) {
      await ledger?.transitionIngressState?.(providerEventId, 'dead_lettered');
      throw error;
    }
    await ledger?.transitionIngressState?.(providerEventId, 'dispatched');
    return { status: 202, eventId: providerEventId, state: 'dispatched', classification: classification.classification };
  } catch (error) {
    return { ...safeResponse(error), eventId: event?.eventId ?? event?.id ?? null };
  }
}
