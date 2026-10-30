import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';

test('accept logs relay.accept_received before any repository call and accept_done after', async (t) => {
  const order = [];
  t.mock.method(console, 'info', (line) => order.push(JSON.parse(String(line).replace(/^sigil\.hop /, '')).hop));
  const repository = new Proxy({}, {
    get: (_target, name) => (name === 'then' ? undefined : (...args) => { order.push(`repo.${String(name)}`); if (name === 'withTransaction') return Promise.reject(new Error('db down')); return Promise.resolve(null); }),
  });
  const envelope = { message_id: 'msg_1', sender: { endpoint_id: 'ep_a' }, recipient: { endpoint_id: 'ep_b' }, conversation_id: 'conv_1', body: { text: 'secret body' } };
  await acceptEnvelopeAsync(envelope, { repository, registered: new Map() }).catch(() => {});
  assert.equal(order[0], 'relay.accept_received');
  assert.equal(order.at(-1), 'relay.accept_done', order.join(','));
  assert.ok(order.indexOf('relay.accept_received') < order.findIndex((o) => o.startsWith('repo.')), order.join(','));
});
