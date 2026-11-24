import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepository } from './postgres-repository.mjs';

test('Postgres mention pages use the stable descending keyset and cap results', async () => {
  let call;
  const rows = [
    { room_seq: '9', conversation_id: 'room_b', message_id: 'msg_2' },
    { room_seq: '9', conversation_id: 'room_a', message_id: 'msg_3' },
    { room_seq: '9', conversation_id: 'room_a', message_id: 'msg_2' },
  ];
  const repository = new PostgresRepository({ pool: { query: async (sql, values) => {
    call = { sql, values };
    return { rows };
  } } });

  const page = await repository.listMentionsForEndpoint('ep_web', 2, {
    room_seq: '10', conversation_id: 'room_z', message_id: 'msg_9',
  });

  assert.deepEqual(page, { items: rows.slice(0, 2), hasMore: true });
  assert.deepEqual(call.values, ['ep_web', '10', 'room_z', 'msg_9', 3]);
  assert.match(call.sql, /e\.room_seq DESC, e\.conversation_id COLLATE "C" DESC, e\.message_id COLLATE "C" DESC/);
  assert.match(call.sql, /e\.conversation_id COLLATE "C" < \$3::text COLLATE "C"/);
});
