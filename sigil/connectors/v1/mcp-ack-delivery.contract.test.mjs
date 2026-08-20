import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from './mcp-stdio-server.mjs';

async function captureReplies(run) {
  const replies = [];
  const original = process.stdout.write;
  process.stdout.write = (value) => {
    replies.push(JSON.parse(value));
    return true;
  };
  try {
    await run();
    return replies;
  } finally {
    process.stdout.write = original;
  }
}

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

test('shared MCP ack_delivery dispatches delivery ID and outcome to runtime', async () => {
  const calls = [];
  const handler = createMcpHandler({
    runtime: 'codex',
    ackDelivery: async (input) => {
      calls.push(input);
      return { delivery_id: input.delivery_id, outcome: input.outcome };
    },
  });
  const [reply] = await captureReplies(() => handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'sigil_ack_delivery',
      arguments: { delivery_id: 'del_contract_1', outcome: 'processed' },
    },
  }));

  assert.deepEqual(calls, [
    { delivery_id: 'del_contract_1', outcome: 'processed' },
  ]);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    delivery_id: 'del_contract_1',
    outcome: 'processed',
  });
});
