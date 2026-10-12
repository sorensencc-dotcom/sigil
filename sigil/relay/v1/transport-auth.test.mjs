import test from 'node:test';
import assert from 'node:assert/strict';
import { createBearerAuthenticator, hashBearerToken } from './transport-auth.mjs';

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('bearer authenticator resolves hashed endpoint token without exposing token', async () => {
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]));
  assert.deepEqual(await authenticate(bearer('secret_1')), { endpoint_id: 'ep_claude' });
  assert.equal(await authenticate(bearer('wrong')), null);
  assert.equal(await authenticate({ headers: {} }), null);
});

test('bearer authenticator resolves owner_id/human_id from the registry when given', async () => {
  const registry = new Map([['ep_claude', { owner_id: 'usr_soren', endpoint_id: 'ep_claude', status: 'active', kind: 'human' }]]);
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]), registry);
  assert.deepEqual(await authenticate(bearer('secret_1')), { endpoint_id: 'ep_claude', owner_id: 'usr_soren', human_id: 'usr_soren' });
});

test('bearer authenticator falls back to endpoint-only principal when the registry has no owner_id for the endpoint', async () => {
  const registry = new Map([['ep_other', { owner_id: 'usr_other', endpoint_id: 'ep_other', status: 'active' }]]);
  const authenticate = createBearerAuthenticator(new Map([[hashBearerToken('secret_1'), 'ep_claude']]), registry);
  assert.deepEqual(await authenticate(bearer('secret_1')), { endpoint_id: 'ep_claude' });
});

test('only human-kind endpoints get human_id', async () => {
  const registry = new Map([['ep_web', { owner_id: 'usr_chris', kind: 'human' }], ['ep_claude', { owner_id: 'usr_chris', kind: 'agent' }]]);
  const auth = createBearerAuthenticator(new Map([[hashBearerToken('h'), 'ep_web'], [hashBearerToken('a'), 'ep_claude']]), registry);
  assert.equal((await auth(bearer('h'))).human_id, 'usr_chris');
  const agent = await auth(bearer('a'));
  assert.equal(agent.human_id, undefined);
  assert.equal(agent.owner_id, 'usr_chris');
});

test('human_id is granted only when registry kind is exactly human', async () => {
  for (const [kind, expectHuman] of [['human', true], ['agent', false], ['system', false], [undefined, false]]) {
    const registry = new Map([['ep_x', { owner_id: 'usr_chris', kind }]]);
    const auth = createBearerAuthenticator(new Map([[hashBearerToken('t'), 'ep_x']]), registry);
    const principal = await auth(bearer('t'));
    assert.equal(principal.owner_id, 'usr_chris', `kind=${kind}`);
    assert.equal(principal.human_id, expectHuman ? 'usr_chris' : undefined, `kind=${kind}`);
  }
});

// Repository-backed mode: Postgres state decides, cached per endpoint.
function fakeRepository(rows) {
  const reads = new Map();
  return {
    rows,
    reads,
    async livenessSnapshot({ endpointId }) {
      reads.set(endpointId, (reads.get(endpointId) ?? 0) + 1);
      const row = rows.get(endpointId);
      return row ? { ...row } : null;
    },
  };
}

const activeRow = (owner_id, kind) => ({ owner_id, kind, endpoint_status: 'active', has_active_key: true, human_status: 'active' });

function setup() {
  let clock = 1_000_000;
  const repository = fakeRepository(new Map([
    ['ep_web', activeRow('hum_a', 'human')],
    ['ep_agent', activeRow('hum_a', 'agent')],
    ['ep_other', activeRow('hum_b', 'human')],
  ]));
  // The registry deliberately disagrees with Postgres: the repository must win.
  const registry = new Map([['ep_web', { owner_id: 'usr_stale', kind: 'agent' }]]);
  const hashes = new Map([[hashBearerToken('w'), 'ep_web'], [hashBearerToken('g'), 'ep_agent'], [hashBearerToken('o'), 'ep_other']]);
  const auth = createBearerAuthenticator(hashes, registry, { repository, now: () => clock });
  return { repository, auth, advance: (ms) => { clock += ms; } };
}

test('repository-backed: principal comes from Postgres, human_id only for kind human', async () => {
  const { auth } = setup();
  assert.deepEqual(await auth(bearer('w')), { endpoint_id: 'ep_web', owner_id: 'hum_a', human_id: 'hum_a' });
  assert.deepEqual(await auth(bearer('g')), { endpoint_id: 'ep_agent', owner_id: 'hum_a' });
  assert.equal(await auth(bearer('nope')), null);
});

test('repository-backed: one read per endpoint per 5 s TTL', async () => {
  const { repository, auth, advance } = setup();
  await auth(bearer('w'));
  await auth(bearer('w'));
  advance(4_999);
  await auth(bearer('w'));
  assert.equal(repository.reads.get('ep_web'), 1);
  advance(1);
  await auth(bearer('w'));
  assert.equal(repository.reads.get('ep_web'), 2);
});

test('repository-backed: suspended human, inactive endpoint, missing key, or missing row yield null', async () => {
  for (const change of [{ human_status: 'suspended' }, { endpoint_status: 'revoked' }, { endpoint_status: 'suspended' }, { has_active_key: false }, null]) {
    const { repository, auth } = setup();
    if (change === null) repository.rows.delete('ep_web');
    else Object.assign(repository.rows.get('ep_web'), change);
    assert.equal(await auth(bearer('w')), null, JSON.stringify(change));
  }
});

test('repository-backed: a failed read fails closed and is not cached', async () => {
  const { repository, auth } = setup();
  const original = repository.livenessSnapshot;
  repository.livenessSnapshot = async () => { throw new Error('db down'); };
  assert.equal(await auth(bearer('w')), null);
  repository.livenessSnapshot = original;
  assert.equal((await auth(bearer('w'))).endpoint_id, 'ep_web');
});

test('clear({ endpointId }) forces a requery of that endpoint only', async () => {
  const { repository, auth } = setup();
  await auth(bearer('w'));
  await auth(bearer('o'));
  repository.rows.get('ep_web').endpoint_status = 'revoked';
  assert.ok(await auth(bearer('w')), 'cached before clear');
  auth.clear({ endpointId: 'ep_web' });
  assert.equal(await auth(bearer('w')), null);
  await auth(bearer('o'));
  assert.equal(repository.reads.get('ep_other'), 1);
});

test('clear({ humanId }) clears every endpoint owned by that human', async () => {
  const { repository, auth } = setup();
  await auth(bearer('w'));
  await auth(bearer('g'));
  await auth(bearer('o'));
  for (const id of ['ep_web', 'ep_agent']) repository.rows.get(id).human_status = 'suspended';
  auth.clear({ humanId: 'hum_a' });
  assert.equal(await auth(bearer('w')), null);
  assert.equal(await auth(bearer('g')), null);
  assert.ok(await auth(bearer('o')));
  assert.equal(repository.reads.get('ep_other'), 1);
});

test('clearAll drops every cached entry', async () => {
  const { repository, auth } = setup();
  await auth(bearer('w'));
  await auth(bearer('o'));
  auth.clearAll();
  await auth(bearer('w'));
  await auth(bearer('o'));
  assert.equal(repository.reads.get('ep_web'), 2);
  assert.equal(repository.reads.get('ep_other'), 2);
});

test('a read in flight when clear runs is not served or cached', async () => {
  const { repository, auth } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = repository.livenessSnapshot;
  let first = true;
  repository.livenessSnapshot = async (arg) => {
    const snapshot = await original(arg);
    if (first) { first = false; await gate; }
    return snapshot;
  };
  const pending = auth(bearer('w'));
  await new Promise((resolve) => setImmediate(resolve));
  repository.rows.get('ep_web').human_status = 'suspended';
  auth.clear({ endpointId: 'ep_web' });
  release();
  assert.equal(await pending, null);
  assert.equal(await auth(bearer('w')), null);
});
