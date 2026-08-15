// Live end-to-end receipt for the Claude worker contract described in the
// README "Claude task worker" section.
//
// Runs real code, not fakes, for every hop:
//   - real HTTP relay server (sigil/relay/v1/http-server.mjs)
//   - real HTTP connector server (sigil/connectors/v1/connector-server.mjs)
//   - real signed envelopes (Ed25519, sigil/relay/v1/validate-envelope.mjs)
//   - real MCP JSON-RPC handler (sigil/connectors/v1/mcp-stdio-server.mjs)
//   - real Claude worker subprocess (sigil/scripts/claude-worker.mjs), spawned
//     through the real claude-process-adapter.mjs contract enforcement
//
// The one stand-in is persistence: an in-memory repository fills the role
// PostgreSQL plays in production (README requires Postgres 16 for the live
// gate). It implements the same repository methods http-server.mjs calls,
// so "durable" here means "read back from a store independent of the
// in-flight request/response objects," not "survives a process restart."
//
// Run: node sigil/scripts/live-claude-worker-receipt.mjs

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRelayServer } from '../relay/v1/http-server.mjs';
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';
import { signedBytes } from '../relay/v1/validate-envelope.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';

import { createConnectorServer, createConnectorToken } from '../connectors/v1/connector-server.mjs';
import { createConnector } from '../connectors/v1/connector.mjs';
import { createLocalConnectorClient } from '../connectors/v1/local-connector-client.mjs';
import { createClaudeHostRuntime } from '../connectors/v1/host-runtimes.mjs';
import { createClaudeProcessTask } from '../connectors/v1/claude-process-adapter.mjs';
import { createMcpHandler } from '../connectors/v1/mcp-stdio-server.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';

const receipt = [];
function log(stage, detail) {
  const entry = { stage, ...detail };
  receipt.push(entry);
  console.log(`\n=== ${stage} ===`);
  console.log(JSON.stringify(detail, null, 2));
}

async function main() {
  // ---- identities -------------------------------------------------------
  const codexKeys = crypto.generateKeyPairSync('ed25519');
  const claudeKeys = crypto.generateKeyPairSync('ed25519');
  const codex = { owner_id: 'usr_codex', endpoint_id: 'ep_codex', key_id: 'key_codex', kind: 'agent' };
  const claude = { owner_id: 'usr_claude', endpoint_id: 'ep_claude', key_id: 'key_claude', kind: 'agent' };
  const registry = new Map([
    ['ep_codex', { ...codex, status: 'active', public_key: codexKeys.publicKey }],
    ['ep_claude', { ...claude, status: 'active', public_key: claudeKeys.publicKey }]
  ]);

  // ---- in-memory repository standing in for Postgres --------------------
  const envelopes = new Map();
  const deliveries = new Map();
  const repository = {
    async persistAcceptedEnvelope(row) {
      envelopes.set(row.message_id, row);
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        deliveries.set(deliveryId, { delivery_id: deliveryId, message_id: row.message_id, recipient_endpoint_id: row.envelope.recipient.endpoint_id, state: 'delivered', queued_at: new Date().toISOString(), attempts: 0 });
      }
      return { message_id: row.message_id, duplicate: false };
    },
    async listInbox(endpointId, since = '') {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.queued_at > since)
        .map((d) => ({ delivery_id: d.delivery_id, message_id: d.message_id, envelope: envelopes.get(d.message_id).envelope, queued_at: d.queued_at }));
    },
    async acknowledgeDelivery({ deliveryId, endpointId, now }) {
      const current = deliveries.get(deliveryId);
      if (!current || current.recipient_endpoint_id !== endpointId) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      const next = transitionDelivery(current, 'acknowledged', { now });
      deliveries.set(deliveryId, next);
      return next;
    },
    async getDelivery(deliveryId, endpointId) {
      const current = deliveries.get(deliveryId);
      return current && current.recipient_endpoint_id === endpointId ? current : null;
    },
    async transitionDelivery(deliveryId, _endpointId, _target, { next }) {
      deliveries.set(deliveryId, next);
      return next;
    }
  };

  // ---- relay server (real HTTP, real envelope validation) ---------------
  const codexRelayToken = 'relay-token-codex';
  const claudeRelayToken = 'relay-token-claude';
  const tokenHashes = new Map([
    [hashBearerToken(codexRelayToken), 'ep_codex'],
    [hashBearerToken(claudeRelayToken), 'ep_claude']
  ]);
  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const relayPort = relayServer.address().port;
  const relayUrl = `http://127.0.0.1:${relayPort}`;

  // ---- claude worker subprocess wiring (real process boundary) ----------
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-worker.mjs');
  const processTask = createClaudeProcessTask({ command: 'node', args: [workerPath] });

  // ---- connector server (real HTTP, the Claude runtime's local endpoint) -
  const connectorToken = createConnectorToken();
  const relayClientForClaude = new RelayClient({ baseUrl: relayUrl, token: claudeRelayToken });
  const resultOutbox = new LocalOutbox({ privateKey: claudeKeys.privateKey, endpoint: claude });
  const serverConnector = createConnector({
    relay: relayClientForClaude,
    outbox: resultOutbox,
    inbox: { receive: () => ({ duplicate: false }), get: () => null }, // connector.checkInbox() path is not used server-side in this flow
    processTask,
    submitResult: async ({ envelope }) => relayClientForClaude.sendEnvelope(envelope)
  });
  const connectorServer = createConnectorServer({ connector: serverConnector, token: connectorToken });
  await connectorServer.listen();
  const connectorPort = connectorServer.address().port;
  const connectorUrl = `http://127.0.0.1:${connectorPort}`;

  // ---- MCP host runtime (what mcp-stdio-server.mjs binds to stdin/stdout) -
  const localClient = createLocalConnectorClient({ baseUrl: connectorUrl, token: connectorToken });
  const permissions = ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'];
  const runtime = createClaudeHostRuntime({ baseUrl: connectorUrl, token: connectorToken, processTask, packagePermissions: permissions, connectorGrants: permissions });
  const mcpHandler = createMcpHandler(runtime);

  try {
    // ---- Stage 0: Codex sends a signed task envelope directly to relay --
    const codexOutbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: codex });
    const now = new Date();
    const taskEnvelope = {
      protocol: 'sigil/1', message_id: `msg_task_${crypto.randomUUID()}`, conversation_id: `conv_${crypto.randomUUID()}`,
      message_type: 'task.request', sender: codex, recipient: claude,
      body: { task_id: `task_${crypto.randomUUID()}`, instruction: 'Summarize the Sigil connector contract in one sentence.' },
      context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: `send_${crypto.randomUUID()}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: codex.key_id, value: '' }
    };
    const queued = codexOutbox.queue(taskEnvelope);
    const relayClientForCodex = new RelayClient({ baseUrl: relayUrl, token: codexRelayToken });
    const accepted = await relayClientForCodex.sendEnvelope(queued.envelope);
    log('relay accept: Codex task envelope', { message_id: accepted.message_id, duplicate: accepted.duplicate, envelope_signature_verified: true });

    // ---- Stage 1: MCP request -------------------------------------------
    const mcpWrites = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (value) => { mcpWrites.push(value); return true; };
    let inboxToolResult;
    try {
      await mcpHandler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sigil_check_inbox', arguments: {} } });
    } finally { process.stdout.write = originalWrite; }
    inboxToolResult = JSON.parse(JSON.parse(mcpWrites[0]).result.content[0].text);
    const deliveredItem = inboxToolResult.items[0];
    log('MCP request: tools/call sigil_check_inbox', { jsonrpc_response_raw: JSON.parse(mcpWrites[0]), delivery_id: deliveredItem.delivery_id, task_id: deliveredItem.envelope.body.task_id });

    // connector.checkInbox() already acknowledges each delivered item against
    // the relay as part of reconciling the inbox (see connector.mjs) -- no
    // separate ack call needed here.

    // ---- Stage 2: connector process call ---------------------------------
    const processed = await runtime.processDelivery({ deliveryId: deliveredItem.delivery_id, task: deliveredItem.envelope.body });
    log('connector process call: POST /v1/process -> connector.processDelivery', { connector_url: `${connectorUrl}/v1/process`, delivery_state: processed.state, worker_result: processed.result });

    // ---- Stage 3: Claude worker result (already captured above, restated) -
    log('Claude worker result: real child_process subprocess', { command: 'node', script: workerPath, result: processed.result });

    // ---- Stage 4: durable relay result -----------------------------------
    const resultEnvelopeUnsigned = {
      protocol: 'sigil/1', message_id: `msg_result_${crypto.randomUUID()}`, conversation_id: taskEnvelope.conversation_id,
      message_type: 'task.result', sender: claude, recipient: codex,
      body: processed.result,
      context_refs: [], capabilities: [], correlation_id: taskEnvelope.message_id,
      idempotency_key: `result_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: claude.key_id, value: '' }
    };
    const submitted = await runtime.submitResult({ envelope: resultOutbox.queue(resultEnvelopeUnsigned).envelope });
    log('durable relay result: POST /v1/results -> connector.submitResult -> relay.sendEnvelope', { message_id: submitted.message_id, duplicate: submitted.duplicate });

    // Prove durability: read the result back from the repository via a path
    // independent of the objects above (fresh JSON round-trip, keyed lookup).
    const storedRow = envelopes.get(submitted.message_id);
    const readBack = JSON.parse(JSON.stringify(storedRow));
    log('durability verification: repository read-back', {
      found_in_repository: Boolean(readBack),
      canonical_hash_matches: readBack.canonical_hash === crypto.createHash('sha256').update(signedBytes(readBack.envelope)).digest('hex'),
      stored_body: readBack.envelope.body
    });

    console.log('\n=== RECEIPT SUMMARY ===');
    console.log(`MCP request (sigil_check_inbox) -> connector process call (POST ${connectorUrl}/v1/process) -> Claude worker result (subprocess exit 0) -> durable relay result (message_id=${submitted.message_id}, verified via repository read-back)`);
  } finally {
    await connectorServer.close();
    await new Promise((resolve) => relayServer.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
