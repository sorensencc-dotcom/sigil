// sigil/bridges/v1/session-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from './session-store.mjs';

test('stores per-room sessions across instances', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-sess-')), 'nested', 'sessions.json');
  const store = createSessionStore(file);
  assert.equal(store.get('room_1'), null);
  store.set('room_1', { session_id: 's1', last_seq: '4' });
  assert.deepEqual(createSessionStore(file).get('room_1'), { session_id: 's1', last_seq: '4' });
});
