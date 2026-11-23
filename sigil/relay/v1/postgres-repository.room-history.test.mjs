import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepository } from './postgres-repository.mjs';

test('room history uses descending keyset queries and returns pages in chronological order', async () => {
  let call;
  const pool = { async query(text, values) {
    call = { text, values };
    return { rows: [{ room_seq: '8' }, { room_seq: '7' }] };
  } };
  const repository = new PostgresRepository({ pool });
  const rows = await repository.listRoomMessagesBefore('room_1', 9n, 2);
  assert.match(call.text, /room_seq < \$2/);
  assert.match(call.text, /ORDER BY room_seq DESC/);
  assert.deepEqual(call.values, ['room_1', '9', 2]);
  assert.deepEqual(rows.map((row) => row.room_seq), ['7', '8']);
});

test('room search escapes LIKE metacharacters and uses the trigram-compatible predicate', async () => {
  let call;
  const pool = { async query(text, values) { call = { text, values }; return { rows: [] }; } };
  const repository = new PostgresRepository({ pool });
  await repository.searchRoomMessages('room_1', 'x%_\\y', null, 10);
  assert.match(call.text, /message_type = 'room\.message'/);
  assert.match(call.text, /body->>'text' ILIKE \$2/);
  assert.ok(call.text.includes("ESCAPE E'\\\\'"));
  assert.equal(call.values[1], '%x\\%\\_\\\\y%');
  assert.deepEqual(call.values.slice(0, 1), ['room_1']);
});
