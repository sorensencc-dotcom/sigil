import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from './mcp-stdio-server.mjs';

test('stdio MCP handler exposes approved tools and dispatches connector calls', async () => {
  const writes = [];
  const handler = createMcpHandler({ runtime: 'codex', sendTask: async (input) => ({ accepted: input.value }) });
  const original = process.stdout.write; process.stdout.write = (value) => { writes.push(JSON.parse(value)); return true; };
  try {
    await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sigil_send_task', arguments: { value: 'ok' } } });
  } finally { process.stdout.write = original; }
  assert.equal(writes[0].result.tools.length, 5); assert.equal(JSON.parse(writes[1].result.content[0].text).accepted, 'ok');
});

test('stdio MCP handler rejects unavailable runtime operations', async () => {
  const writes = []; const handler = createMcpHandler({ runtime: 'codex' });
  const original = process.stdout.write; process.stdout.write = (value) => { writes.push(JSON.parse(value)); return true; };
  try { await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sigil_send_task', arguments: {} } }); } finally { process.stdout.write = original; }
  assert.equal(writes[0].error.code, -32001);
});
