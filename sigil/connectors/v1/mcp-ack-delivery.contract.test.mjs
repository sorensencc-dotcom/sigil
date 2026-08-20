import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from './mcp-stdio-server.mjs';
import { createCodexHostRuntime, createClaudeHostRuntime } from './host-runtimes.mjs';
import { createConnectorServer } from './connector-server.mjs';

async function captureReplies(run) {
  const replies = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') ?? '';
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          replies.push(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON runner output
        }
      }
    }
    return true;
  };
  try {
    await run();
    return replies;
  } finally {
    process.stdout.write = original;
  }
}

const permissions = ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'];

test('shared MCP contract advertises ack_delivery', async () => {
  const handler = createMcpHandler({ runtime: 'codex' });
  const [reply] = await captureReplies(() => handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  }));

  assert.ok(
    reply.result.tools.some((tool) => tool.name === 'sigil_ack_delivery'),
    'plugin connector auth spec section 2.2 requires connector.ack_delivery',
  );
});

test('shared MCP ack_delivery dispatches end-to-end through real Codex host runtime and connector server', async () => {
  const acks = [];
  const server = createConnectorServer({
    token: 'server-token',
    connector: {
      async sendTask() { return { accepted: true }; },
      async checkInbox() { return { items: [] }; },
      async getResult(id) { return { id }; },
      async ackDelivery(input) {
        acks.push(input);
        return { delivery_id: input.delivery_id, outcome: input.outcome ?? 'processed' };
      },
      async requestApproval() { return { approved: false }; },
      async resolveContext() { return { found: true }; },
    },
  });
  await server.listen();
  const port = server.address().port;

  try {
    const runtime = createCodexHostRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'server-token',
      packagePermissions: permissions,
      connectorGrants: permissions,
    });
    const handler = createMcpHandler(runtime);
    const [reply] = await captureReplies(() => handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'sigil_ack_delivery',
        arguments: { delivery_id: 'del_contract_1', outcome: 'processed' },
      },
    }));

    assert.deepEqual(acks, [
      { delivery_id: 'del_contract_1', outcome: 'processed' },
    ]);
    assert.deepEqual(JSON.parse(reply.result.content[0].text), {
      delivery_id: 'del_contract_1',
      outcome: 'processed',
    });
  } finally {
    await server.close();
  }
});

test('shared MCP ack_delivery dispatches end-to-end through real Claude host runtime and connector server', async () => {
  const acks = [];
  const server = createConnectorServer({
    token: 'claude-token',
    connector: {
      async checkInbox() { return { items: [] }; },
      async getResult(id) { return { id }; },
      async ackDelivery(input) {
        acks.push(input);
        return { delivery_id: input.delivery_id, outcome: input.outcome ?? 'processed' };
      },
      async requestApproval() { return { approved: false }; },
      async resolveContext() { return { found: true }; },
      async processTask() { return { processed: true }; },
      async processDelivery() { return { state: 'processed' }; },
      async submitResult() { return { accepted: true }; },
    },
  });
  await server.listen();
  const port = server.address().port;

  try {
    const runtime = createClaudeHostRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'claude-token',
      processTask: async () => ({ ok: true }),
      packagePermissions: permissions,
      connectorGrants: permissions,
    });
    const handler = createMcpHandler(runtime);
    const [reply] = await captureReplies(() => handler({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'sigil_ack_delivery',
        arguments: { delivery_id: 'del_claude_1', outcome: 'processed' },
      },
    }));

    assert.deepEqual(acks, [
      { delivery_id: 'del_claude_1', outcome: 'processed' },
    ]);
    assert.deepEqual(JSON.parse(reply.result.content[0].text), {
      delivery_id: 'del_claude_1',
      outcome: 'processed',
    });
  } finally {
    await server.close();
  }
});

test('shared MCP ack_delivery forwards delivery_rejected outcome and reason', async () => {
  const acks = [];
  const server = createConnectorServer({
    token: 'reject-token',
    connector: {
      async checkInbox() { return { items: [] }; },
      async getResult(id) { return { id }; },
      async ackDelivery(input) {
        acks.push(input);
        return { delivery_id: input.delivery_id, outcome: input.outcome, reason: input.reason };
      },
      async requestApproval() { return { approved: false }; },
      async resolveContext() { return { found: true }; },
    },
  });
  await server.listen();
  const port = server.address().port;

  try {
    const runtime = createCodexHostRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'reject-token',
      packagePermissions: permissions,
      connectorGrants: permissions,
    });
    const handler = createMcpHandler(runtime);
    const [reply] = await captureReplies(() => handler({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'sigil_ack_delivery',
        arguments: { delivery_id: 'del_reject_1', outcome: 'delivery_rejected', reason: 'payload schema mismatch' },
      },
    }));

    assert.deepEqual(acks, [
      { delivery_id: 'del_reject_1', outcome: 'delivery_rejected', reason: 'payload schema mismatch' },
    ]);
    assert.deepEqual(JSON.parse(reply.result.content[0].text), {
      delivery_id: 'del_reject_1',
      outcome: 'delivery_rejected',
      reason: 'payload schema mismatch',
    });
  } finally {
    await server.close();
  }
});

test('shared MCP ack_delivery forwards processing_failed outcome and reason', async () => {
  const acks = [];
  const server = createConnectorServer({
    token: 'failed-token',
    connector: {
      async checkInbox() { return { items: [] }; },
      async getResult(id) { return { id }; },
      async ackDelivery(input) {
        acks.push(input);
        return { delivery_id: input.delivery_id, outcome: input.outcome, reason: input.reason };
      },
      async requestApproval() { return { approved: false }; },
      async resolveContext() { return { found: true }; },
    },
  });
  await server.listen();
  const port = server.address().port;

  try {
    const runtime = createCodexHostRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'failed-token',
      packagePermissions: permissions,
      connectorGrants: permissions,
    });
    const handler = createMcpHandler(runtime);
    const [reply] = await captureReplies(() => handler({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'sigil_ack_delivery',
        arguments: { delivery_id: 'del_failed_1', outcome: 'processing_failed', reason: 'subprocess exit code 1' },
      },
    }));

    assert.deepEqual(acks, [
      { delivery_id: 'del_failed_1', outcome: 'processing_failed', reason: 'subprocess exit code 1' },
    ]);
    assert.deepEqual(JSON.parse(reply.result.content[0].text), {
      delivery_id: 'del_failed_1',
      outcome: 'processing_failed',
      reason: 'subprocess exit code 1',
    });
  } finally {
    await server.close();
  }
});

test('ackDelivery is denied when connector only holds read_inbox capability without process', async () => {
  const readOnlyPermissions = ['sigil.task/read_inbox', 'sigil.task/read_result', 'sigil.approval/request', 'sigil.core/read_shared_context'];
  assert.throws(
    () => createCodexHostRuntime({
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok',
      packagePermissions: readOnlyPermissions,
      connectorGrants: readOnlyPermissions,
    }),
    (error) => error.code === 'CAPABILITY_DENIED' && error.capability === 'sigil.task/process',
  );
});
