import crypto from 'node:crypto';
import { resolveInboxMapping } from './agentmail-config.mjs';
import { buildIngressProvenance, deriveIngressIdempotencyKey } from './agentmail-provenance.mjs';
import { buildTaskRequest } from './build-task-request.mjs';
import { classifyInboundMessage } from './classify.mjs';
import { createAgentMailLedger } from './agentmail-ledger.mjs';
import { emitIngressReceipt } from './agentmail-receipts.mjs';
import { acceptEnvelopeAsync } from '../../relay/v1/accept-envelope.mjs';

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
  FINANCIAL_LOCAL_ROUTE_REQUIRED: 403,
  QUEUE_SATURATED: 429,
  AGENTMAIL_PROVIDER_TIMEOUT: 504,
  SENDER_RATE_LIMITED: 429,
  QUARANTINE_STORAGE_UNAVAILABLE: 503,
  INSTRUCTION_NORMALIZATION_REQUIRED: 400,
  ENDPOINT_UNAVAILABLE: 503,
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
    FINANCIAL_LOCAL_ROUTE_REQUIRED: 'Financial-sensitive handling requires an explicitly local recipient endpoint',
    QUEUE_SATURATED: 'Ingress queue is saturated',
    AGENTMAIL_PROVIDER_TIMEOUT: 'AgentMail provider timed out',
    SENDER_RATE_LIMITED: 'Sender rate limit exceeded for AgentMail ingress',
    QUARANTINE_STORAGE_UNAVAILABLE: 'Encrypted quarantine storage is unavailable',
    INSTRUCTION_NORMALIZATION_REQUIRED: 'A normalized instruction is required for task ingress',
    ENDPOINT_UNAVAILABLE: 'Recipient endpoint is not active for AgentMail ingress',
  })[code] ?? 'AgentMail message was rejected';
}

function tokenRecord(tokenStore, alias) {
  if (tokenStore instanceof Map) return tokenStore.get(alias);
  return tokenStore?.[alias];
}

function readSnapshotSecret(snapshot, method, key) {
  if (!snapshot || typeof snapshot[method] !== 'function') fail('AGENTMAIL_INGRESS_UNAVAILABLE', 'AgentMail secret snapshot is unavailable');
  return snapshot[method](key, (secret) => {
    if (!secret || typeof secret.withValue !== 'function') fail('SECRET_SNAPSHOT_INVALID', 'AgentMail secret snapshot is invalid');
    return secret.withValue((value) => value);
  });
}

function resolveWorkflowFromSnapshot(address, snapshot, { domain } = {}) {
  if (typeof address !== 'string' || address.trim() === '') fail('INVALID_FORWARDING_TOKEN', 'Forwarding address is required');
  const trimmed = address.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address does not match the required grammar');
  if (domain && trimmed.slice(atIndex + 1).toLowerCase() !== String(domain).trim().toLowerCase()) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address domain is not configured');
  const parts = trimmed.slice(0, atIndex).split('+');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !TOKEN_PATTERN.test(parts[2])) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address does not match the required grammar');
  const alias = `${parts[0]}+${parts[1]}`;
  const expectedToken = readSnapshotSecret(snapshot, 'withForwardingToken', alias);
  if (typeof expectedToken !== 'string' || !TOKEN_PATTERN.test(expectedToken)) fail('INVALID_FORWARDING_TOKEN', 'Configured forwarding token is invalid');
  if (parts[2].length !== expectedToken.length || !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expectedToken))) fail('TOKEN_MISMATCH', 'Forwarding token workflow mismatch');
  return { alias, endpointAlias: parts[0], workflow: parts[1] };
}

export function resolveWorkflow(address, tokenStore = {}, { domain } = {}) {
  if (typeof address !== 'string' || address.trim() === '') fail('INVALID_FORWARDING_TOKEN', 'Forwarding address is required');
  const trimmed = address.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address does not match the required grammar');
  if (domain && trimmed.slice(atIndex + 1).toLowerCase() !== String(domain).trim().toLowerCase()) fail('INVALID_FORWARDING_TOKEN', 'Forwarding address domain is not configured');
  const localPart = trimmed.slice(0, atIndex);
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

async function quarantineAttachments(event, quarantine, maxAttachmentBytes) {
  if ((event.attachments ?? []).length > 0 && typeof quarantine !== 'function') fail('QUARANTINE_STORAGE_UNAVAILABLE', 'Encrypted quarantine storage is required for attachments');
  const results = [];
  for (const attachment of event.attachments ?? []) {
    const stream = attachment.stream ?? attachment.content;
    if (stream === undefined) fail('INVALID_ATTACHMENT', 'Attachment content is unavailable');
    results.push(await quarantine(stream, { ...attachment, ...(attachment.metadata ?? {}), maxBytes: maxAttachmentBytes }));
  }
  return results;
}

async function verifyWebhook(provider, args, maxParserSeconds) {
  if (typeof provider?.verifyWebhook !== 'function') fail('WEBHOOK_SIGNATURE_INVALID', 'Webhook authenticity could not be verified');
  const timeoutMs = Number.isSafeInteger(maxParserSeconds) && maxParserSeconds > 0 ? maxParserSeconds * 1000 : null;
  if (!timeoutMs) return provider.verifyWebhook(args);
  let timer;
  try {
    return await Promise.race([
      provider.verifyWebhook(args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('AgentMail parser timed out'), { code: 'AGENTMAIL_PROVIDER_TIMEOUT' })), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAgentMailWebhook({ rawBody, headers, inboxId, provider, registry, secretStore, ingress, ledger, policy = {}, quarantine, maxAttachmentBytes, maxParserSeconds, senderRateLimiter, enqueue, clock = () => new Date() } = {}) {
  let event;
  let providerEventId = null;
  let deadLettered = false;
  let receipt = null;
  try {
    const mapping = registry?.resolveInboxMapping
      ? registry.resolveInboxMapping(inboxId)
      : resolveInboxMapping(registry?.inboxMappings, inboxId);
    const snapshot = secretStore?.current?.();
    if (!snapshot) fail('AGENTMAIL_INGRESS_UNAVAILABLE', 'AgentMail secret snapshot is unavailable');
    const webhookSecret = readSnapshotSecret(snapshot, 'withWebhookSecret', mapping.webhookSecretId);
    event = await verifyWebhook(provider, { rawBody, headers, inboxId, webhookSecretId: mapping.webhookSecretId, webhookSecret }, maxParserSeconds);
    if (!event || typeof event !== 'object') fail('WEBHOOK_SIGNATURE_INVALID', 'Webhook authenticity could not be verified');
    const registeredEndpoint = registry instanceof Map ? registry.get(mapping.endpointId) : registry?.endpoints?.get?.(mapping.endpointId);
    if (registeredEndpoint && registeredEndpoint.status !== 'active') fail('ENDPOINT_UNAVAILABLE', 'Recipient endpoint is not active');
    if (registry instanceof Map && !registeredEndpoint) fail('ENDPOINT_UNAVAILABLE', 'Recipient endpoint is not registered');
    const sender = String(event.from ?? event.sender?.email ?? '').trim().toLowerCase();
    if (!exactSenderAllowed(event, policy)) fail('SENDER_NOT_ALLOWLISTED', 'Sender is not authorized for AgentMail ingress');
    if (typeof senderRateLimiter === 'function' && !(await senderRateLimiter(sender, clock()))) fail('SENDER_RATE_LIMITED', 'Sender rate limit exceeded');
    if (mapping.endpointId === 'ep_iron' && (event.external === true || event.sender?.internal !== true)) fail('IRON_EXTERNAL_MAIL_REJECTED', 'External mail is not accepted by the iron endpoint');
    const workflow = resolveWorkflowFromSnapshot(event.alias ?? event.to, snapshot, { domain: policy.forwardingDomain });
    if (!mapping.workflowPolicy.includes(workflow.workflow)) fail('TOKEN_MISMATCH', 'Workflow is not allowed for this inbox');
    providerEventId = String(event.eventId ?? event.id ?? '');
    const providerMessageId = String(event.messageId ?? event.message_id ?? '');
    const derivedKey = deriveIngressIdempotencyKey({ providerEventId, providerMessageId, inboxId });
    const existing = await ledger?.recordIngressEvent?.({ eventId: providerEventId, providerEventId, providerMessageId, inboxId, idempotencyKey: derivedKey, state: 'received', workflow: workflow.workflow });
    if (existing?.duplicate || (existing?.state && existing.state !== 'received')) return { status: 202, eventId: providerEventId, state: existing.state, duplicate: true };
    const clockValue = clock();
    const now = clockValue instanceof Date ? clockValue : new Date(clockValue);
    const attachmentResults = await quarantineAttachments(event, quarantine, maxAttachmentBytes);
    await ledger?.transitionIngressState?.(providerEventId, 'quarantined');
    const classification = classifyInboundMessage({ sender: { email: sender, internal: event.sender?.internal === true }, workflow: workflow.workflow, body: String(event.body ?? ''), attachments: event.attachments ?? [] });
    if (classification.classification === 'financial_sensitive' && typeof quarantine.setRetention === 'function') {
      for (const attachment of attachmentResults.filter(Boolean)) await quarantine.setRetention(attachment.reference, { retentionClass: 'short' });
    }
    if (classification.classification === 'financial_sensitive' && policy.allowFinancialLocalOnly !== true) fail('FINANCIAL_APPROVAL_REQUIRED', 'Financial-sensitive handling requires explicit approval');
    if (classification.classification === 'financial_sensitive' && !(policy.localOnlyEndpointIds ?? []).includes(mapping.endpointId)) fail('FINANCIAL_LOCAL_ROUTE_REQUIRED', 'Financial-sensitive handling requires an explicitly local recipient endpoint');
    const provenance = buildIngressProvenance({
      providerEventId, providerMessageId, inboxId, verifiedSender: sender, workflow: workflow.workflow,
      classification: classification.classification,
      attachmentHashes: attachmentResults.filter(Boolean), receivedAt: now.toISOString(),
    });
    await ledger?.updateIngressMetadata?.(providerEventId, { provenance });
    if (mapping.endpointId === 'ep_judgment') {
      receipt = emitIngressReceipt({ event: { eventId: providerEventId, correlationId: `corr_${providerEventId}` }, outcome: { state: 'quarantined' }, signer: ingress.signer, createdAt: now.toISOString() });
      return { status: 202, eventId: providerEventId, state: 'quarantined', classification: classification.classification, receipt };
    }
    if (typeof enqueue !== 'function') fail('QUEUE_UNAVAILABLE', 'Ingress queue is unavailable');
    const conversationId = event.conversationId ?? `conv_${crypto.randomUUID()}`;
    const contextRefs = attachmentResults.filter(Boolean).map((attachment) => ({ scope: `scope:conversation/${conversationId}`, reference: attachment.reference, sha256: attachment.sha256 }));
    const instruction = await policy.normalizeInstruction?.(event) ?? event.sanitizedInstruction ?? event.normalizedInstruction ?? event.normalizedText;
    if (typeof instruction !== 'string' || instruction.trim() === '') fail('INSTRUCTION_NORMALIZATION_REQUIRED', 'A normalized instruction is required for task ingress');
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
    let enqueueResult;
    try {
      enqueueResult = await enqueue(envelope, { localOnly: classification.policy.localOnly, workflow: workflow.workflow });
    } catch (error) {
      deadLettered = true;
      await ledger?.transitionIngressState?.(providerEventId, 'dead_lettered');
      throw error;
    }
    await ledger?.transitionIngressState?.(providerEventId, 'dispatched', { envelopeMessageId: enqueueResult?.body?.message_id ?? envelope.message_id });
    receipt = emitIngressReceipt({ event: { eventId: providerEventId, correlationId: envelope.correlation_id }, outcome: { state: 'dispatched' }, signer: ingress.signer, createdAt: now.toISOString() });
    return { status: 202, eventId: providerEventId, state: 'dispatched', classification: classification.classification, receipt };
  } catch (error) {
    if (providerEventId && !deadLettered) {
      try {
        await ledger?.transitionIngressState?.(providerEventId, 'rejected', { rejectionCode: error?.code ?? 'AGENTMAIL_INGRESS_REJECTED' });
      } catch {
        // Preserve the original redacted response when ledger cleanup cannot complete.
      }
    }
    if (providerEventId && ingress?.signer) {
      try {
        receipt = emitIngressReceipt({ event: { eventId: providerEventId, correlationId: `corr_${providerEventId}` }, outcome: { state: 'rejected', rejectionCode: error?.code ?? 'AGENTMAIL_INGRESS_REJECTED' }, signer: ingress.signer, createdAt: new Date(clock()).toISOString() });
      } catch {
        // Preserve the original redacted rejection when receipt signing is unavailable.
      }
    }
    return { ...safeResponse(error), eventId: event?.eventId ?? event?.id ?? null, receipt };
  }
}

export function createAgentMailIngress({ config, provider, secretStore, ingress, repository, registry, quarantine, policy = {}, relayOptions = {} } = {}) {
  if (!config?.inboxMappings || !provider || !secretStore || !ingress || !repository) fail('AGENTMAIL_INGRESS_UNAVAILABLE', 'AgentMail ingress requires config, secret store, provider, identity, and repository');
  const ledger = createAgentMailLedger({ repository, maxQueueDepth: config.limits?.maxQueueDepth });
  const effectivePolicy = {
    ...policy,
    senderAllowlist: policy.senderAllowlist ?? config.senderAllowlist,
    forwardingDomain: policy.forwardingDomain ?? config.forwardingDomain,
  };
  const inboxMappings = config.inboxMappings.map((mapping) => ({ ...mapping }));
  const senderBuckets = new Map();
  const senderRateLimiter = async (sender, timestamp) => {
    const minute = Math.floor(new Date(timestamp).getTime() / 60_000);
    for (const [key, bucket] of senderBuckets) if (bucket.minute !== minute) senderBuckets.delete(key);
    const bucket = senderBuckets.get(sender) ?? { minute, count: 0 };
    if (bucket.count >= config.limits.senderPerMinute) return false;
    bucket.count += 1;
    senderBuckets.set(sender, bucket);
    return true;
  };
  return {
    maxMessageBytes: config.limits?.maxMessageBytes,
    async handleWebhook({ rawBody, headers, inboxId, clock = () => new Date(), now } = {}) {
      return handleAgentMailWebhook({
        rawBody,
        headers,
        inboxId,
        secretStore,
        provider,
        registry: { inboxMappings, endpoints: registry },
        ingress,
        ledger,
        policy: effectivePolicy,
        quarantine,
        maxAttachmentBytes: config.limits?.maxAttachmentBytes,
        maxParserSeconds: config.limits?.maxParserSeconds,
        senderRateLimiter,
        clock: now ? () => now : clock,
        enqueue: async (envelope) => {
          const result = await acceptEnvelopeAsync(envelope, { repository, registered: registry, ...relayOptions });
          if (result.status >= 400) throw Object.assign(new Error(result.body?.message ?? 'Sigil relay rejected ingress envelope'), { code: result.body?.code ?? 'INGRESS_RELAY_REJECTED' });
          return result;
        },
      });
    },
  };
}

export { resolveWorkflowFromSnapshot };
