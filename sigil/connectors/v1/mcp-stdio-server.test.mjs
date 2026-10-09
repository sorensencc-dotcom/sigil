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
  assert.equal(writes[0].result.tools.length, 9); assert.equal(JSON.parse(writes[1].result.content[0].text).accepted, 'ok');
});

test('stdio MCP handler routes room tools to the runtime', async () => {
  const writes = [];
  const handler = createMcpHandler({
    runtime: 'codex',
    listRooms: async () => [{ conversation_id: 'room_1' }],
    readRoom: async (args) => ({ items: [], echoed: args.room_id }),
    postMessage: async (args) => ({ code: 'OK', text: args.text }),
  });
  const original = process.stdout.write; process.stdout.write = (value) => { writes.push(JSON.parse(value)); return true; };
  try {
    await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sigil_list_rooms', arguments: {} } });
    await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sigil_read_room', arguments: { room_id: 'room_1' } } });
    await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sigil_post_message', arguments: { room_id: 'room_1', text: 'hi' } } });
  } finally { process.stdout.write = original; }
  assert.equal(JSON.parse(writes[0].result.content[0].text)[0].conversation_id, 'room_1');
  assert.equal(JSON.parse(writes[1].result.content[0].text).echoed, 'room_1');
  assert.equal(JSON.parse(writes[2].result.content[0].text).text, 'hi');
});

test('stdio MCP handler rejects unavailable runtime operations', async () => {
  const writes = []; const handler = createMcpHandler({ runtime: 'codex' });
  const original = process.stdout.write; process.stdout.write = (value) => { writes.push(JSON.parse(value)); return true; };
  try { await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sigil_send_task', arguments: {} } }); } finally { process.stdout.write = original; }
  assert.equal(writes[0].error.code, -32001);
});

test('stdio MCP handler unwraps scalar inbox and result arguments', async () => {
  const calls = [];
  const handler = createMcpHandler({ runtime: 'codex', checkInbox: async (since) => { calls.push(['inbox', since]); return { items: [] }; }, getResult: async (taskId) => { calls.push(['result', taskId]); return { taskId }; } });
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sigil_check_inbox', arguments: { since: 'cursor-1' } } });
    await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sigil_get_result', arguments: { task_id: 'task-1' } } });
  } finally { process.stdout.write = original; }
  assert.deepEqual(calls, [['inbox', 'cursor-1'], ['result', 'task-1']]);
});
