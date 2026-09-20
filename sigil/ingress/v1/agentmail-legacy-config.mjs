import { loadAgentMailConfig } from './agentmail-config.mjs';

const RAW_KEYS = Object.freeze(['SIGIL_AGENTMAIL_WEBHOOK_SECRETS', 'SIGIL_AGENTMAIL_FORWARDING_TOKENS']);

function parseObject(raw, field) {
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(`${field} must contain valid JSON`), { code: 'AGENTMAIL_CONFIG_INVALID', details: { field } }); }
}

function envRef(prefix, name) {
  const safe = String(name).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return `env://${prefix}_${safe}`;
}

export function loadLegacyAgentMailConfig(env = process.env, { mode = 'test' } = {}) {
  if (mode === 'production') throw Object.assign(new Error('Raw AgentMail credentials are not allowed in production'), { code: 'SECRET_POLICY_VIOLATION', details: { mode } });
  const rawWebhooks = env.SIGIL_AGENTMAIL_WEBHOOK_SECRETS;
  const rawTokens = env.SIGIL_AGENTMAIL_FORWARDING_TOKENS;
  if (typeof rawWebhooks !== 'string' || typeof rawTokens !== 'string') throw Object.assign(new Error('Legacy AgentMail credentials are incomplete'), { code: 'AGENTMAIL_CONFIG_MISSING', details: { fields: RAW_KEYS } });
  const webhooks = parseObject(rawWebhooks, RAW_KEYS[0]);
  const tokens = parseObject(rawTokens, RAW_KEYS[1]);
  const webhookRefs = Object.fromEntries(Object.keys(webhooks).map((id) => [id, envRef('AGENTMAIL_WEBHOOK_SECRET', id)]));
  const tokenRefs = Object.fromEntries(Object.keys(tokens).map((alias) => [alias, envRef('AGENTMAIL_FORWARDING_TOKEN', alias)]));
  const canonicalEnv = {
    ...env,
    SIGIL_AGENTMAIL_WEBHOOK_SECRET_REFS: JSON.stringify(webhookRefs),
    SIGIL_AGENTMAIL_FORWARDING_TOKEN_REFS: JSON.stringify(tokenRefs),
  };
  delete canonicalEnv.SIGIL_AGENTMAIL_WEBHOOK_SECRETS;
  delete canonicalEnv.SIGIL_AGENTMAIL_FORWARDING_TOKENS;
  const config = loadAgentMailConfig(canonicalEnv, { mode });
  const values = new Map();
  for (const [id, value] of Object.entries(webhooks)) values.set(envRef('AGENTMAIL_WEBHOOK_SECRET', id), value);
  for (const [alias, value] of Object.entries(tokens)) values.set(envRef('AGENTMAIL_FORWARDING_TOKEN', alias), value);
  return Object.freeze({
    config,
    providers: Object.freeze({
      env: async ({ reference }) => ({ value: values.get(`env://${reference.path}`), version: 'legacy-local-test' }),
    }),
    compatibility: Object.freeze({ rawConfigUsed: true }),
  });
}

export { RAW_KEYS };
