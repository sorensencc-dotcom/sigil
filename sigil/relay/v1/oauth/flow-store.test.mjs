import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFlowStore } from './flow-store.mjs';

test('take is single-use and keyed by cookie', () => {
  const store = createFlowStore();
  const { cookieValue, flow } = store.start({ provider: 'github', inviteId: 'inv_1' });
  assert.equal(store.take('wrong'), null);
  assert.deepEqual(store.take(cookieValue), flow);
  assert.equal(store.take(cookieValue), null);
});
test('challenge is S256 of the verifier', () => {
  const { flow } = createFlowStore().start({ provider: 'github' });
  const expected = crypto.createHash('sha256').update(flow.pkceVerifier).digest('base64url');
  assert.equal(flow.codeChallenge, expected);
});
test('expires and caps', () => {
  let t = 0;
  const store = createFlowStore({ now: () => new Date(t), ttlMs: 1000, maxEntries: 2 });
  const a = store.start({ provider: 'github' });
  store.start({ provider: 'github' });
  assert.throws(() => store.start({ provider: 'github' }), { code: 'FLOW_CAP' });
  t = 2000;
  assert.equal(store.take(a.cookieValue), null); // expired
  assert.doesNotThrow(() => store.start({ provider: 'github' })); // sweep freed room
});
