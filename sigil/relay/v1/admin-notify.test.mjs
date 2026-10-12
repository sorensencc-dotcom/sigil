import test from 'node:test';
import assert from 'node:assert/strict';
import { publishAdmin, parseAdminPayload, createAdminMessageHandler } from './admin-notify.mjs';

const fakeClient = () => {
  const queries = [];
  return { queries, query: async (text, values) => { queries.push({ text, values }); return { rows: [] }; } };
};

test('publishAdmin calls pg_notify on sigil_admin with the JSON payload on the given client', async () => {
  const client = fakeClient();
  await publishAdmin(client, { type: 'endpoint.revoked', endpoint_id: 'ep_a' });
  assert.equal(client.queries.length, 1);
  assert.equal(client.queries[0].text, 'SELECT pg_notify($1, $2)');
  assert.deepEqual(client.queries[0].values, ['sigil_admin', JSON.stringify({ type: 'endpoint.revoked', endpoint_id: 'ep_a' })]);
});

test('publishAdmin rejects an unknown type without notifying', async () => {
  const client = fakeClient();
  await assert.rejects(publishAdmin(client, { type: 'human.deleted', human_id: 'hum_a' }), { code: 'INVALID_ADMIN_TYPE' });
  assert.equal(client.queries.length, 0);
});

test('publishAdmin rejects a payload of 8000 bytes or more with PAYLOAD_TOO_LARGE', async () => {
  const client = fakeClient();
  const room_ids = Array.from({ length: 400 }, (_, i) => `room_${String(i).padStart(16, '0')}`);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'room.members', room_ids })) >= 8000);
  await assert.rejects(publishAdmin(client, { type: 'room.members', room_ids }), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(client.queries.length, 0);
});

test('parseAdminPayload accepts the fixed shape and rejects malformed input', () => {
  assert.deepEqual(parseAdminPayload('{"type":"room.members","room_ids":["room_a"]}'), { type: 'room.members', room_ids: ['room_a'] });
  assert.deepEqual(parseAdminPayload('{"type":"human.suspended","human_id":"hum_a"}'), { type: 'human.suspended', human_id: 'hum_a' });
  for (const raw of ['not json', 'null', '[]', '{"type":"nope"}', '{"type":"endpoint.revoked","endpoint_id":5}',
    '{"type":"room.members","room_ids":"room_a"}', '{"type":"room.members","room_ids":[1]}', '{"type":"human.suspended","human_id":null}']) {
    assert.equal(parseAdminPayload(raw), null, raw);
  }
});

function harness() {
  const calls = [];
  const auth = { clear: (arg) => calls.push(['clear', arg]), clearAll: () => calls.push(['clearAll']) };
  const stream = { revalidate: async (arg) => { calls.push(['revalidate', arg]); }, notifyRoom: () => true };
  return { calls, auth, stream };
}

test('admin handler clears the cache for every message and revalidates only on revoking types', async () => {
  const { calls, auth, stream } = harness();
  const handle = createAdminMessageHandler({ auth, stream, repository: {}, logger: null });
  await handle({ type: 'human.unsuspended', human_id: 'hum_a' });
  await handle({ type: 'endpoint.revoked', endpoint_id: 'ep_a' });
  await handle({ type: 'human.suspended', human_id: 'hum_b' });
  await handle({ type: 'identity.revoked', human_id: 'hum_c' });
  assert.deepEqual(calls, [
    ['clear', { humanId: 'hum_a', endpointId: undefined }],
    ['clear', { humanId: undefined, endpointId: 'ep_a' }],
    ['revalidate', { humanId: undefined, endpointId: 'ep_a' }],
    ['clear', { humanId: 'hum_b', endpointId: undefined }],
    ['revalidate', { humanId: 'hum_b', endpointId: undefined }],
    ['clear', { humanId: 'hum_c', endpointId: undefined }],
    ['revalidate', { humanId: 'hum_c', endpointId: undefined }],
  ]);
});

test('admin handler reads room members on a transaction client, never a null client', async () => {
  const { auth, stream } = harness();
  const txClient = { tx: true };
  const seen = [];
  const repository = {
    withTransaction: async (fn) => fn(txClient),
    listRoomMembers: async (roomId, client) => { seen.push([roomId, client]); return []; },
  };
  const handle = createAdminMessageHandler({ auth, stream, repository, logger: null });
  await handle({ type: 'room.members', room_ids: ['room_a', 'room_b'] });
  assert.deepEqual(seen, [['room_a', txClient], ['room_b', txClient]]);
});
