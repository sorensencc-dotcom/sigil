import test from 'node:test';
import assert from 'node:assert/strict';
import { createBearerAuthenticator, hashBearerToken } from './transport-auth.mjs';

test('bearer authenticator resolves hashed endpoint token without exposing token', () => {
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]));
  assert.deepEqual(authenticate({ headers: { authorization: 'Bearer secret_1' } }), { endpoint_id: 'ep_claude' });
  assert.equal(authenticate({ headers: { authorization: 'Bearer wrong' } }), null);
  assert.equal(authenticate({ headers: {} }), null);
});
