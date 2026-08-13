import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from './sqlite-store.mjs';

test('SQLite store persists and deduplicates inbox messages', () => {
  const store = new SqliteStore();
  assert.equal(store.putInbox({ message_id: 'msg_1', body: {} }).duplicate, false);
  assert.equal(store.putInbox({ message_id: 'msg_1', body: { changed: true } }).duplicate, true);
  assert.deepEqual(store.getInbox('msg_1').envelope, { message_id: 'msg_1', body: {} });
  store.close();
});
