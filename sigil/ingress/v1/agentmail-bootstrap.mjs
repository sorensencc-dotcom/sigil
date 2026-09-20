import { loadAgentMailConfig } from './agentmail-config.mjs';
import { loadLegacyAgentMailConfig } from './agentmail-legacy-config.mjs';
import { createSecretResolver } from './agentmail-secret-resolver.mjs';
import { buildAgentMailSecretSnapshot, createAgentMailSecretStore } from './agentmail-secret-snapshot.mjs';
import { createAgentMailTransport } from './agentmail-transport.mjs';
import { createAgentMailIngress } from './agentmail-adapter.mjs';
import { createAgentMailControl } from './agentmail-control.mjs';
import { authorizeAgentMailControl } from './agentmail-control-policy.mjs';
import { createAgentMailControlHandler, rotateAgentMailSecrets } from './agentmail-rotation.mjs';

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }

export async function createAgentMailDeployment({ env = process.env, mode = 'production', registry, ingress, repository, providerFactory, secretProviders = {}, providerRotation, clock = () => new Date() } = {}) {
  if (env.SIGIL_AGENTMAIL_ENABLE !== '1') return null;
  if (mode === 'production' && !repository?.pool && repository?.isPostgres !== true) fail('AGENTMAIL_POSTGRES_REQUIRED', 'Production AgentMail ingress requires PostgreSQL-backed control state');
  let config; let compatibility = { rawConfigUsed: false }; let providers = secretProviders;
  const hasRaw = env.SIGIL_AGENTMAIL_WEBHOOK_SECRETS !== undefined || env.SIGIL_AGENTMAIL_FORWARDING_TOKENS !== undefined;
  if (hasRaw) {
    const legacy = loadLegacyAgentMailConfig(env, { mode });
    config = legacy.config; providers = { ...legacy.providers, ...secretProviders }; compatibility = legacy.compatibility;
  } else config = loadAgentMailConfig(env, { mode });
  if (typeof providerFactory !== 'function') fail('AGENTMAIL_PROVIDER_FACTORY_REQUIRED', 'An approved AgentMail provider adapter is required before AgentMail activation');
  const resolver = createSecretResolver({ providers, mode, clock });
  const initialSnapshot = await buildAgentMailSecretSnapshot({ config, resolver, generation: 'gen_1', clock });
  const secretStore = createAgentMailSecretStore(initialSnapshot, { clock });
  const transport = createAgentMailTransport({ secretStore });
  const provider = await providerFactory({ config, secretStore, transport });
  if (!provider || typeof provider.verifyWebhook !== 'function') fail('AGENTMAIL_PROVIDER_INVALID', 'AgentMail provider adapter does not expose webhook verification');
  const control = createAgentMailControl({ repository, notify: repository?.notify, clock });
  await control.cache.refresh();
  const rotation = (request) => rotateAgentMailSecrets({ ...request, control, secretStore, resolver, providerRotation, config, actor: request.actor, clock, authorize: (args) => authorizeAgentMailControl({ ...args, repository }) });
  const agentmailControl = {
    ...control,
    compatibility,
    handle: createAgentMailControlHandler({ control, rotation, authorize: (args) => authorizeAgentMailControl({ ...args, repository }) }),
  };
  const rawIngress = createAgentMailIngress({ config, provider, secretStore, ingress, repository, registry });
  const agentmailIngress = {
    maxMessageBytes: rawIngress.maxMessageBytes,
    async handleWebhook(input) {
      const state = agentmailControl.cache.current();
      if (state.state !== 'enabled') return { status: 503, body: { code: 'AGENTMAIL_INGRESS_DISABLED', message: 'AgentMail ingress is disabled', details: { state: state.state } } };
      return rawIngress.handleWebhook(input);
    },
  };
  return Object.freeze({ agentmailIngress, agentmailControl, close() { control.cache.close(); transport.close(); } });
}
