import test from 'node:test';
import assert from 'node:assert/strict';
import { createBearerAuthenticator, hashBearerToken } from './transport-auth.mjs';

test('bearer authenticator resolves hashed endpoint token without exposing token', () => {
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]));
  assert.deepEqual(authenticate({ headers: { authorization: 'Bearer secret_1' } }), { endpoint_id: 'ep_claude' });
  assert.equal(authenticate({ headers: { authorization: 'Bearer wrong' } }), null);
  assert.equal(authenticate({ headers: {} }), null);
});

test('bearer authenticator resolves owner_id/human_id from the registry when given', () => {
  const registry = new Map([['ep_claude', { owner_id: 'usr_soren', endpoint_id: 'ep_claude', status: 'active' }]]);
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]), registry);
  assert.deepEqual(
    authenticate({ headers: { authorization: 'Bearer secret_1' } }),
    { endpoint_id: 'ep_claude', owner_id: 'usr_soren', human_id: 'usr_soren' }
  );
});

test('bearer authenticator falls back to endpoint-only principal when the registry has no owner_id for the endpoint', () => {
  const registry = new Map([['ep_other', { owner_id: 'usr_other', endpoint_id: 'ep_other', status: 'active' }]]);
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]), registry);
  assert.deepEqual(authenticate({ headers: { authorization: 'Bearer secret_1' } }), { endpoint_id: 'ep_claude' });
});
