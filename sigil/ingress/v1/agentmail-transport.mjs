import { AgentMailClient } from 'agentmail';

function providerError(error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(error?.status) ? error.status : null;
  const code = error?.code === 'AGENTMAIL_PROVIDER_TIMEOUT' || error?.name === 'AgentMailTimeoutError' ? 'AGENTMAIL_PROVIDER_TIMEOUT' : 'AGENTMAIL_PROVIDER_ERROR';
  return Object.assign(new Error(code === 'AGENTMAIL_PROVIDER_TIMEOUT' ? 'AgentMail provider timed out' : 'AgentMail provider request failed'), { code, status, cause: error });
}

export function createAgentMailTransport({ apiKey, clientFactory } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw Object.assign(new Error('AgentMail API key is required'), { code: 'AGENTMAIL_CONFIG_MISSING' });
  const createClient = clientFactory ?? ((key) => new AgentMailClient({ apiKey: () => key }));
  const client = createClient(apiKey);
  if (!client?.inboxes?.webhooks?.create || !client?.inboxes?.messages?.get || !client?.inboxes?.messages?.send) throw Object.assign(new Error('AgentMail client does not expose required inbox resources'), { code: 'AGENTMAIL_CLIENT_INVALID' });
  const call = async (operation) => {
    try { return await operation(); } catch (error) { throw providerError(error); }
  };
  return {
    registerWebhook(inboxId, { url, eventTypes = ['message.received'] } = {}) {
      return call(() => client.inboxes.webhooks.create(inboxId, { url, eventTypes }));
    },
    fetchMessage(inboxId, messageId) {
      return call(() => client.inboxes.messages.get(inboxId, messageId));
    },
    sendMessage(inboxId, request) {
      return call(() => client.inboxes.messages.send(inboxId, request));
    },
  };
}

export { providerError };
