const ENDPOINT_POLICIES = Object.freeze({
  ep_triage: Object.freeze(['trm', 'roadmap', 'eval']),
  ep_judgment: Object.freeze(['review', 'approval']),
  ep_iron: Object.freeze(['internal', 'test']),
});

const DEFAULT_LIMITS = Object.freeze({
  maxMessageBytes: 10 * 1024 * 1024,
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxParserSeconds: 120,
  maxRetries: 3,
  maxQueueDepth: 100,
  senderPerMinute: 10,
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('AGENTMAIL_CONFIG_MISSING', `${field} is required`, { field });
  return value.trim();
}

function parseJson(value, field) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') fail('AGENTMAIL_CONFIG_MISSING', `${field} is required`, { field });
  try { return JSON.parse(value); } catch { fail('AGENTMAIL_CONFIG_INVALID', `${field} must contain valid JSON`, { field }); }
}

function read(env, key) {
  return env?.[key];
}

function normalizeMappings(value, webhookSecrets) {
  const parsed = parseJson(value, 'SIGIL_AGENTMAIL_INBOX_MAPPINGS');
  const entries = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed ?? {}).map(([providerInboxId, record]) => ({ providerInboxId, ...record }));
  if (entries.length !== 3) fail('AGENTMAIL_CONFIG_INVALID', 'Exactly three AgentMail inbox mappings are required', { field: 'inboxMappings' });
  const seenProvider = new Set();
  const seenEndpoint = new Set();
  const expectedEndpoints = new Set(['ep_triage', 'ep_judgment', 'ep_iron']);
  return entries.map((entry) => {
    const providerInboxId = requiredString(entry?.providerInboxId ?? entry?.provider_inbox_id, 'providerInboxId');
    const endpointId = requiredString(entry?.endpointId ?? entry?.endpoint_id, 'endpointId');
    if (seenProvider.has(providerInboxId) || seenEndpoint.has(endpointId)) {
      fail('MULTIPLE_INBOX_MAPPING', 'AgentMail inbox and endpoint mappings must be one-to-one', { providerInboxId, endpointId });
    }
    if (!expectedEndpoints.has(endpointId)) fail('AGENTMAIL_CONFIG_INVALID', 'AgentMail inbox must map to a canonical endpoint', { endpointId });
    const webhookSecretId = requiredString(entry?.webhookSecretId ?? entry?.webhook_secret_id, 'webhookSecretId');
    if (!Object.hasOwn(webhookSecrets, webhookSecretId)) fail('AGENTMAIL_CONFIG_INVALID', 'AgentMail inbox webhook secret is not configured', { providerInboxId, webhookSecretId });
    seenProvider.add(providerInboxId);
    seenEndpoint.add(endpointId);
    const workflowPolicy = Array.isArray(entry.workflowPolicy)
      ? entry.workflowPolicy.map((workflow) => requiredString(workflow, 'workflowPolicy'))
      : ENDPOINT_POLICIES[endpointId];
    if (!workflowPolicy?.length) fail('AGENTMAIL_CONFIG_INVALID', `No workflow policy configured for ${endpointId}`, { endpointId });
    return Object.freeze({ providerInboxId, endpointId, webhookSecretId, workflowPolicy: Object.freeze([...new Set(workflowPolicy)]) });
  });
}

function normalizeLimits(env) {
  const raw = read(env, 'SIGIL_AGENTMAIL_LIMITS');
  const parsed = raw == null || raw === '' ? {} : parseJson(raw, 'SIGIL_AGENTMAIL_LIMITS');
  const aliases = {
    maxMessageBytes: ['maxMessageBytes', 'max_message_bytes', 'SIGIL_AGENTMAIL_MAX_MESSAGE_BYTES'],
    maxAttachmentBytes: ['maxAttachmentBytes', 'max_attachment_bytes', 'SIGIL_AGENTMAIL_MAX_ATTACHMENT_BYTES'],
    maxParserSeconds: ['maxParserSeconds', 'max_parser_seconds', 'SIGIL_AGENTMAIL_MAX_PARSER_SECONDS'],
    maxRetries: ['maxRetries', 'max_retries', 'SIGIL_AGENTMAIL_MAX_RETRIES'],
    maxQueueDepth: ['maxQueueDepth', 'max_queue_depth', 'SIGIL_AGENTMAIL_MAX_QUEUE_DEPTH'],
    senderPerMinute: ['senderPerMinute', 'sender_per_minute', 'SIGIL_AGENTMAIL_SENDER_PER_MINUTE'],
  };
  const limits = {};
  for (const [name, keys] of Object.entries(aliases)) {
    const candidate = keys.map((key) => parsed[key] ?? read(env, key)).find((value) => value !== undefined);
    const value = candidate === undefined ? DEFAULT_LIMITS[name] : Number(candidate);
    if (!Number.isSafeInteger(value) || value <= 0) fail('AGENTMAIL_CONFIG_INVALID', `${name} must be a positive integer`, { field: name });
    limits[name] = value;
  }
  return Object.freeze(limits);
}

export function loadAgentMailConfig(env = process.env) {
  const webhookSecrets = parseJson(read(env, 'SIGIL_AGENTMAIL_WEBHOOK_SECRETS'), 'SIGIL_AGENTMAIL_WEBHOOK_SECRETS');
  if (!webhookSecrets || Array.isArray(webhookSecrets) || typeof webhookSecrets !== 'object' || Object.keys(webhookSecrets).length === 0) {
    fail('AGENTMAIL_CONFIG_INVALID', 'SIGIL_AGENTMAIL_WEBHOOK_SECRETS must be a non-empty object', { field: 'webhookSecrets' });
  }
  for (const [key, value] of Object.entries(webhookSecrets)) {
    requiredString(key, 'webhook secret id');
    requiredString(value, 'webhook secret');
  }
  const apiKeyRef = requiredString(read(env, 'SIGIL_AGENTMAIL_API_KEY_REF'), 'SIGIL_AGENTMAIL_API_KEY_REF');
  if (!/^(secret|env):\/\//.test(apiKeyRef)) fail('AGENTMAIL_CONFIG_INVALID', 'AgentMail API key must be a secret reference', { field: 'apiKeyRef' });
  const forwardingDomain = requiredString(read(env, 'SIGIL_AGENTMAIL_FORWARDING_DOMAIN'), 'SIGIL_AGENTMAIL_FORWARDING_DOMAIN').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(forwardingDomain)) fail('AGENTMAIL_CONFIG_INVALID', 'Forwarding domain is invalid', { field: 'forwardingDomain' });
  const inboxMappings = normalizeMappings(read(env, 'SIGIL_AGENTMAIL_INBOX_MAPPINGS'), webhookSecrets);
  const senderAllowlist = parseJson(read(env, 'SIGIL_AGENTMAIL_SENDER_ALLOWLIST'), 'SIGIL_AGENTMAIL_SENDER_ALLOWLIST');
  if (!Array.isArray(senderAllowlist) || senderAllowlist.length === 0 || senderAllowlist.some((sender) => typeof sender !== 'string' || sender.trim() === '')) {
    fail('AGENTMAIL_CONFIG_INVALID', 'Sender allowlist must be a non-empty string array', { field: 'senderAllowlist' });
  }
  const forwardingTokens = parseJson(read(env, 'SIGIL_AGENTMAIL_FORWARDING_TOKENS'), 'SIGIL_AGENTMAIL_FORWARDING_TOKENS');
  if (!forwardingTokens || Array.isArray(forwardingTokens) || typeof forwardingTokens !== 'object' || Object.keys(forwardingTokens).length === 0) {
    fail('AGENTMAIL_CONFIG_INVALID', 'Forwarding tokens must be a non-empty object', { field: 'forwardingTokens' });
  }
  for (const [alias, token] of Object.entries(forwardingTokens)) {
    requiredString(alias, 'forwarding token alias');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(token)) fail('AGENTMAIL_CONFIG_INVALID', `Invalid forwarding token for ${alias}`, { field: 'forwardingTokens' });
  }
  return Object.freeze({
    webhookSecrets: Object.freeze({ ...webhookSecrets }),
    apiKeyRef,
    forwardingDomain,
    inboxMappings: Object.freeze(inboxMappings),
    senderAllowlist: Object.freeze(senderAllowlist.map((sender) => sender.trim().toLowerCase())),
    forwardingTokens: Object.freeze({ ...forwardingTokens }),
    limits: normalizeLimits(env),
  });
}

export function resolveInboxMapping(inboxMappings, providerInboxId) {
  const matches = (inboxMappings ?? []).filter((mapping) => mapping?.providerInboxId === providerInboxId);
  if (matches.length > 1) fail('MULTIPLE_INBOX_MAPPING', 'AgentMail inbox has multiple endpoint mappings', { providerInboxId });
  if (matches.length === 0) fail('UNKNOWN_INBOX', 'AgentMail inbox is not registered', { providerInboxId });
  return matches[0];
}

export { DEFAULT_LIMITS, ENDPOINT_POLICIES };
