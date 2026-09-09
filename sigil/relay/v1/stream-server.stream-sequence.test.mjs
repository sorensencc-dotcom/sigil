import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer } from './stream-server.mjs';

async function connectedStream(t) {
  const server = http.createServer();
  const stream = createStreamServer({ server, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => server.listen(0, resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_stream' } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  t.after(async () => {
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    await closed;
    await stream.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { socket, stream };
}

test('delivered and delivery.receipt frames include lossless nullable stream sequences', async (t) => {
  const { socket, stream } = await connectedStream(t);
  const delivered = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  assert.equal(stream.notify('ep_stream', 'del_1', 7n), true);
  assert.deepEqual(await delivered, { type: 'delivered', delivery_id: 'del_1', stream_seq: '7' });

  const receipt = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  assert.equal(stream.notifyReceipt('ep_stream', { message_id: 'msg_1', delivery_id: 'del_1', state: 'delivered', at: '2026-09-09T12:00:00.000Z', streamSeq: null }), true);
  assert.deepEqual(await receipt, { type: 'delivery.receipt', message_id: 'msg_1', delivery_id: 'del_1', state: 'delivered', at: '2026-09-09T12:00:00.000Z', stream_seq: null });
});

test('resend and sequence_reset frames reuse the authenticated stream channel', async (t) => {
  const { socket, stream } = await connectedStream(t);
  const resend = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  assert.equal(stream.notifyResend('ep_stream', { delivery_id: 'del_2', streamSeq: 8n }), true);
  assert.deepEqual(await resend, { type: 'resend', delivery_id: 'del_2', stream_seq: '8' });

  const reset = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  assert.equal(stream.notifySequenceReset('ep_stream', { conversation_id: 'conv_stream', streamSeq: 1n }), true);
  assert.deepEqual(await reset, { type: 'sequence_reset', conversation_id: 'conv_stream', stream_seq: '1' });
});
