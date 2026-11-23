// sigil/cli/connector-daemon.mjs
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { createConnector } from '../connectors/v1/connector.mjs';
import { createConnectorServer } from '../connectors/v1/connector-server.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalInbox } from '../connectors/v1/local-inbox.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { loadIdentity } from './identity.mjs';

const options = {
  port: { type: 'string', default: '4411' },
  'relay-url': { type: 'string' },
  identity: { type: 'string', default: '.sigil/grokbot.identity.json' },
  token: { type: 'string', default: 'token_local_dev' }
};

const { values } = parseArgs({ options, allowPositionals: true });
const port = parseInt(values.port, 10);
const relayUrl = values['relay-url'];
const identityPath = values.identity;
const token = values.token;

if (!fs.existsSync(identityPath)) {
  console.error(`Identity file not found: ${identityPath}`);
  process.exit(1);
}

const identity = loadIdentity(identityPath);
const privateKey = crypto.createPrivateKey(identity.private_key_pem ?? identity.private_key);

// Memory-only mode (no --relay-url): /mcp/memory works, relay-backed routes fail closed.
const noRelay = async () => {
  throw Object.assign(new Error('No relay configured for this connector'), { code: 'RELAY_NOT_CONFIGURED' });
};
const relay = relayUrl
  ? new RelayClient({
    baseUrl: relayUrl,
    token: identity.relay_token ?? identity.auth_token ?? identity.bearer_token ?? 'test_token'
  })
  : { sendEnvelope: noRelay, reconcileInbox: noRelay };

const outbox = new LocalOutbox({
  privateKey,
  endpoint: {
    endpoint_id: identity.endpoint_id,
    owner_id: identity.owner_id,
    key_id: identity.key_id ?? identity.keyId ?? `${identity.endpoint_id}#key-1`
  }
});

const inbox = new LocalInbox();

const connector = createConnector({
  relay,
  outbox,
  inbox
});

const connectorApp = createConnectorServer({
  connector,
  token: identity.connector_token ?? token,
  allowedCallers: []
});

connectorApp.server.listen(port, '127.0.0.1', () => {
  console.log(`Sigil Connector HTTP Daemon listening on http://127.0.0.1:${port}`);
  console.log(relayUrl ? `Forwarding tasks to Relay: ${relayUrl}` : 'No relay configured: memory-only mode');
});
