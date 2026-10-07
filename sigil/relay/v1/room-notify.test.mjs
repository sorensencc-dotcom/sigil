import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyRoomHumans } from './room-notify.mjs';
import { withAfterCommitScope } from './after-commit.mjs';

function rig(members) {
  const sent = [];
  const repository = { async listRoomMembers() { return members; } };
  const registered = new Map(members.map((m) => [m.endpoint_id, { kind: m.kind }]));
  const stream = { notifyRoom: (endpointId, frame) => { sent.push([endpointId, frame]); return true; } };
  return { sent, repository, registered, stream };
}

const members = [
  { endpoint_id: 'ep_h1', kind: 'human' },
  { endpoint_id: 'ep_h2', kind: 'human' },
  { endpoint_id: 'ep_agent', kind: 'agent' },
];

test('sends to every human member including the sender, never to agents', async () => {
  const r = rig(members);
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 7, changed: 'messages' });
  assert.deepEqual(r.sent.map(([id]) => id).sort(), ['ep_h1', 'ep_h2']);
  assert.deepEqual(r.sent[0][1], { room_id: 'room_1', room_seq: 7, changed: 'messages' });
});

test('has no 500-delivery cap: 600 human members all get a frame', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ endpoint_id: `ep_h${i}`, kind: 'human' }));
  const r = rig(many);
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages' });
  assert.equal(r.sent.length, 600);
});

test('a members frame omits room_seq', async () => {
  const r = rig(members);
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', changed: 'members' });
  assert.deepEqual(r.sent[0][1], { room_id: 'room_1', changed: 'members' });
});

test('inside a scope nothing is sent until the scope resolves, and nothing if it throws', async () => {
  const r = rig(members);
  await withAfterCommitScope(async () => {
    await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages' });
    assert.equal(r.sent.length, 0);
  });
  assert.equal(r.sent.length, 2);

  const r2 = rig(members);
  await assert.rejects(withAfterCommitScope(async () => {
    await notifyRoomHumans({ ...r2, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages' });
    throw new Error('rollback');
  }));
  assert.equal(r2.sent.length, 0);
});

test('one failing socket does not stop the rest, and no stream is a no-op', async () => {
  const r = rig(members);
  r.stream.notifyRoom = (id) => { if (id === 'ep_h1') throw new Error('socket'); r.sent.push(id); return true; };
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages', logger: { error() {} } });
  assert.deepEqual(r.sent, ['ep_h2']);
  await notifyRoomHumans({ ...r, stream: null, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages' });
});

test('a bigint room_seq becomes a JSON-safe number', async () => {
  const r = rig(members);
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 9n, changed: 'messages' });
  assert.equal(JSON.stringify(r.sent[0][1]), '{"room_id":"room_1","room_seq":9,"changed":"messages"}');
});

test('a failing member read is logged and swallowed, nothing is sent', async () => {
  const r = rig(members);
  r.repository.listRoomMembers = async () => { throw new Error('db down'); };
  const logged = [];
  await notifyRoomHumans({ ...r, client: null, roomId: 'room_1', roomSeq: 1, changed: 'messages', logger: { error: (...args) => logged.push(args) } });
  assert.equal(logged.length, 1);
  assert.deepEqual(r.sent, []);
});
