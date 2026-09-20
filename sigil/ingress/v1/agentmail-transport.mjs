import { AgentMailClient } from 'agentmail';

function providerError(error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(error?.status) ? error.status : null;
  const code = error?.code === 'AGENTMAIL_PROVIDER_TIMEOUT' || error?.name === 'AgentMailTimeoutError' ? 'AGENTMAIL_PROVIDER_TIMEOUT' : 'AGENTMAIL_PROVIDER_ERROR';
  return Object.assign(new Error(code === 'AGENTMAIL_PROVIDER_TIMEOUT' ? 'AgentMail provider timed out' : 'AgentMail provider request failed'), { code, status, cause: error });
}

export function createAgentMailTransport({ secretStore, clientFactory } = {}) {
  if (typeof secretStore?.current !== 'function') throw Object.assign(new Error('AgentMail secret store is required'), { code: 'AGENTMAIL_CONFIG_MISSING' });
  const createClient = clientFactory ?? ((key) => new AgentMailClient({ apiKey: () => key }));
  const clients = new Map();
  const inFlight = new Map();
  const getClient = async (snapshot) => {
    if (!clients.has(snapshot.generation)) {
      const client = await snapshot.withApiKey((secret) => secret.withValue((key) => createClient(key)));
      if (!client?.inboxes?.webhooks?.create || !client?.inboxes?.messages?.get || !client?.inboxes?.messages?.send) throw Object.assign(new Error('AgentMail client does not expose required inbox resources'), { code: 'AGENTMAIL_CLIENT_INVALID' });
      clients.set(snapshot.generation, client);
    }
    return clients.get(snapshot.generation);
  };
  const retire = () => {
    const active = new Set((secretStore.activeSnapshots?.() ?? [secretStore.current()]).map((snapshot) => snapshot.generation));
    for (const [generation] of clients) if (!active.has(generation) && !inFlight.get(generation)) clients.delete(generation);
  };
  const call = async (operation) => {
    const snapshot = secretStore.current();
    const generation = snapshot.generation;
    inFlight.set(generation, (inFlight.get(generation) ?? 0) + 1);
    try { return await operation(await getClient(snapshot)); } catch (error) { throw providerError(error); }
    finally { const count = (inFlight.get(generation) ?? 1) - 1; if (count) inFlight.set(generation, count); else inFlight.delete(generation); secretStore.retireExpired?.(); retire(); }
  };
  return {
    registerWebhook(inboxId, { url, eventTypes = ['message.received'] } = {}) {
      return call((client) => client.inboxes.webhooks.create(inboxId, { url, eventTypes }));
    },
    fetchMessage(inboxId, messageId) {
      return call((client) => client.inboxes.messages.get(inboxId, messageId));
    },
    sendMessage(inboxId, request) {
      return call((client) => client.inboxes.messages.send(inboxId, request));
    },
    close() { clients.clear(); },
  };
}

export { providerError };
