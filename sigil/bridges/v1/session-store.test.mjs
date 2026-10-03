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

test('a corrupt file reads as empty and the next set overwrites it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-sess-')), 'sessions.json');
  fs.writeFileSync(file, '{not json');
  const store = createSessionStore(file);
  assert.equal(store.get('room_1'), null);
  store.set('room_1', { session_id: 's', last_seq: '1' });
  assert.deepEqual(store.get('room_1'), { session_id: 's', last_seq: '1' });
});
