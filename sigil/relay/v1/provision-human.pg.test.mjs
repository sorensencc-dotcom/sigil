import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx, addHumanToRoomsTx, lockManagerRows } from './provision-human.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { unwrapPrivateKey } from './key-wrap.mjs';
import { withTransaction } from './with-transaction.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

test('provisionHumanTx writes the human, endpoint, key, wrapped key, attributes, and audit row', { skip }, async (t) => {
  const pool = await freshPool(t);
  const result = await withTransaction(pool, (client) => provisionHumanTx(client, {
    displayName: 'Alice',
    attributes: [
      { kind: 'email', value: 'alice@example.com', source: 'cli', verification_state: 'provider_verified' },
      { kind: 'name', value: 'Alice A', source: 'cli' },
    ],
    wrapKey,
    now: NOW,
  }));
  assert.match(result.human_id, /^hum_[0-9a-f]{32}$/);
  assert.match(result.endpoint_id, /^ep_[0-9a-f]{32}$/);
  assert.match(result.key_id, /^key_[0-9a-f]{32}$/);

  const human = (await pool.query('SELECT * FROM humans')).rows;
  assert.equal(human.length, 1);
  assert.equal(human[0].human_id, result.human_id);
  assert.equal(human[0].status, 'active');

  const eps = (await pool.query('SELECT * FROM endpoints')).rows;
  assert.equal(eps.length, 1);
  assert.equal(eps[0].endpoint_id, result.endpoint_id);
  assert.equal(eps[0].owner_id, result.human_id);
  assert.equal(eps[0].runtime, 'human');
  assert.equal(eps[0].kind, 'human');
  assert.equal(eps[0].status, 'active');
  assert.equal(eps[0].installation_id, `install_${result.endpoint_id}`);
  assert.equal(eps[0].display_name, 'Alice');

  const keys = (await pool.query('SELECT * FROM endpoint_keys')).rows;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key_id, result.key_id);
  assert.equal(keys[0].endpoint_id, result.endpoint_id);
  assert.equal(keys[0].algorithm, 'Ed25519');
  assert.equal(keys[0].status, 'active');
  assert.equal(keys[0].valid_from.toISOString(), NOW.toISOString());

  const wrapped = (await pool.query('SELECT * FROM human_signing_keys')).rows;
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].key_id, result.key_id);
  const priv = unwrapPrivateKey({ wrapKey, endpointId: result.endpoint_id, keyId: result.key_id, wrapped: wrapped[0].wrapped_private_key });
  const derivedSpki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  assert.ok(derivedSpki.equals(keys[0].public_key));

  const attrs = (await pool.query('SELECT * FROM human_attributes ORDER BY kind')).rows;
  assert.equal(attrs.length, 2);
  assert.deepEqual(attrs.map((a) => a.kind), ['email', 'name']);
  for (const a of attrs) {
    assert.equal(a.human_id, result.human_id);
    assert.equal(a.verification_state, 'unverified');
    assert.equal(a.source, 'cli');
    assert.equal(a.observed_at.toISOString(), NOW.toISOString());
  }
  assert.equal(attrs[0].value_or_ciphertext.toString('utf8'), 'alice@example.com');

  const audit = (await pool.query(`SELECT * FROM audit_events WHERE event_type = 'human.provisioned'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, result.human_id);
  assert.equal(audit[0].object_type, 'human');
  assert.equal(audit[0].object_id, result.human_id);
  assert.equal(audit[0].outcome, 'success');
});

test('an outer rollback leaves no human, endpoint, or key rows', { skip }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    withTransaction(pool, async (client) => {
      await provisionHumanTx(client, { displayName: 'Bob', attributes: [{ kind: 'name', value: 'Bob', source: 'cli' }], wrapKey });
      throw new Error('boom');
    }),
    /boom/,
  );
  for (const table of ['humans', 'endpoints', 'endpoint_keys', 'human_signing_keys', 'human_attributes', 'audit_events']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, table);
  }
});

test('a missing wrap key rejects WRAP_KEY_UNAVAILABLE before any query', async () => {
  const client = { query: async () => { throw new Error('query must not run'); } };
  await assert.rejects(
    provisionHumanTx(client, {}),
    (error) => error.code === 'WRAP_KEY_UNAVAILABLE',
  );
});

test('an attribute without a value rejects INVALID_ATTRIBUTE and stores nothing', { skip }, async (t) => {
  const pool = await freshPool(t);
  for (const value of [undefined, null]) {
    await assert.rejects(
      withTransaction(pool, (client) => provisionHumanTx(client, { wrapKey, attributes: [{ kind: 'email', value }] })),
      (error) => error.code === 'INVALID_ATTRIBUTE',
    );
  }
  for (const table of ['humans', 'human_attributes']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  }
});

test('without a displayName the display name is the endpoint id', { skip }, async (t) => {
  const pool = await freshPool(t);
  const result = await withTransaction(pool, (client) => provisionHumanTx(client, { wrapKey }));
  const row = (await pool.query('SELECT display_name FROM endpoints WHERE endpoint_id = $1', [result.endpoint_id])).rows[0];
  assert.equal(row.display_name, result.endpoint_id);
});

async function seedRoom(pool, roomId, { createdBy, ownerEndpoint }) {
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_t', 'ws_t', $1, $2) ON CONFLICT DO NOTHING`, [createdBy, NOW]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [roomId, createdBy, NOW]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_t', $1, $2)`, [roomId, NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [roomId, ownerEndpoint, createdBy, NOW]);
}

async function setupRooms(t, roomIds = ['room_a', 'room_b']) {
  const pool = await freshPool(t);
  const repository = new PostgresRepository({ pool });
  const actor = await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: 'Actor', wrapKey, now: NOW }));
  const target = await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: 'Target', wrapKey, now: NOW }));
  for (const roomId of roomIds) await seedRoom(pool, roomId, { createdBy: actor.human_id, ownerEndpoint: actor.endpoint_id });
  return { pool, repository, actor, target };
}

const memberRows = async (pool, endpointId) => (await pool.query(
  'SELECT conversation_id, role, added_by, removed_at, invokable_by FROM conversation_members WHERE endpoint_id = $1 ORDER BY conversation_id', [endpointId])).rows;

test('addHumanToRoomsTx adds the target to every room with added_by set to the actor', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  const result = await withTransaction(pool, (client) => addHumanToRoomsTx(client, {
    endpointId: target.endpoint_id,
    memberships: [{ roomId: 'room_b', role: 'room_manager' }, { roomId: 'room_a', role: 'member' }],
    actorHumanId: actor.human_id, repository, now: NOW,
  }));
  assert.deepEqual(result, { room_ids: ['room_a', 'room_b'] });
  const rows = await memberRows(pool, target.endpoint_id);
  assert.deepEqual(rows.map((r) => [r.conversation_id, r.role, r.added_by]), [
    ['room_a', 'member', actor.human_id], ['room_b', 'room_manager', actor.human_id]]);
});

test('a room_manager held through any of the actor endpoints is enough; a plain member is not', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  const manager = await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: 'Mgr', wrapKey, now: NOW }));
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ('ep_manager_second', $1, 'human', 'human', 'install_second', 'second', 'active', $2)`, [manager.human_id, NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', 'ep_manager_second', 'room_manager', $1, $2)`, [actor.human_id, NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', $1, 'member', $2, $3)`, [manager.endpoint_id, actor.human_id, NOW]);
  await withTransaction(pool, (client) => addHumanToRoomsTx(client, {
    endpointId: target.endpoint_id, memberships: [{ roomId: 'room_a', role: 'member' }], actorHumanId: manager.human_id, repository, now: NOW,
  }));
  assert.equal((await memberRows(pool, target.endpoint_id)).length, 1);

  await pool.query(`UPDATE conversation_members SET role = 'member' WHERE endpoint_id = 'ep_manager_second'`);
  await assert.rejects(
    withTransaction(pool, (client) => addHumanToRoomsTx(client, {
      endpointId: target.endpoint_id, memberships: [{ roomId: 'room_a', role: 'room_manager' }], actorHumanId: manager.human_id, repository, now: NOW,
    })),
    (error) => error.code === 'ROUTE_NOT_AUTHORIZED',
  );
});

test('an actor missing from one of two rooms fails and writes nothing', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  const stranger = await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: 'Stranger', wrapKey, now: NOW }));
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', $1, 'room_manager', $2, $3)`, [stranger.endpoint_id, actor.human_id, NOW]);
  await assert.rejects(
    withTransaction(pool, (client) => addHumanToRoomsTx(client, {
      endpointId: target.endpoint_id,
      memberships: [{ roomId: 'room_a', role: 'member' }, { roomId: 'room_b', role: 'member' }],
      actorHumanId: stranger.human_id, repository, now: NOW,
    })),
    (error) => error.code === 'ROUTE_NOT_AUTHORIZED' && error.rooms.join() === 'room_b',
  );
  assert.equal((await memberRows(pool, target.endpoint_id)).length, 0);
});

test('a target provisioned earlier in the same uncommitted transaction is found', { skip }, async (t) => {
  const { pool, repository, actor } = await setupRooms(t);
  const added = await withTransaction(pool, async (client) => {
    const fresh = await provisionHumanTx(client, { displayName: 'Fresh', wrapKey, now: NOW });
    await addHumanToRoomsTx(client, {
      endpointId: fresh.endpoint_id, memberships: [{ roomId: 'room_a', role: 'member' }], actorHumanId: actor.human_id, repository, now: NOW,
    });
    return fresh;
  });
  assert.equal((await memberRows(pool, added.endpoint_id)).length, 1);
});

test('re-adding an active member is a no-op; re-adding a removed member restores it with invokable_by owner', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  const add = (role = 'member') => withTransaction(pool, (client) => addHumanToRoomsTx(client, {
    endpointId: target.endpoint_id, memberships: [{ roomId: 'room_a', role }], actorHumanId: actor.human_id, repository, now: NOW,
  }));
  await add();
  await pool.query(`UPDATE conversation_members SET invokable_by = 'members' WHERE endpoint_id = $1`, [target.endpoint_id]);
  await add('room_manager');
  let [row] = await memberRows(pool, target.endpoint_id);
  assert.equal(row.role, 'member');
  assert.equal(row.invokable_by, 'members');

  await pool.query(`UPDATE conversation_members SET removed_at = $2 WHERE endpoint_id = $1`, [target.endpoint_id, NOW]);
  await add('room_manager');
  [row] = await memberRows(pool, target.endpoint_id);
  assert.equal(row.removed_at, null);
  assert.equal(row.role, 'room_manager');
  assert.equal(row.invokable_by, 'owner');
});

test('roles outside member and room_manager reject INVALID_ROLE', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  await assert.rejects(
    withTransaction(pool, (client) => addHumanToRoomsTx(client, {
      endpointId: target.endpoint_id, memberships: [{ roomId: 'room_a', role: 'owner' }], actorHumanId: actor.human_id, repository, now: NOW,
    })),
    (error) => error.code === 'INVALID_ROLE',
  );
  assert.equal((await memberRows(pool, target.endpoint_id)).length, 0);
});

test('an inactive target is rejected', { skip }, async (t) => {
  const { pool, repository, actor, target } = await setupRooms(t);
  await pool.query(`UPDATE endpoints SET status = 'revoked' WHERE endpoint_id = $1`, [target.endpoint_id]);
  await assert.rejects(
    withTransaction(pool, (client) => addHumanToRoomsTx(client, {
      endpointId: target.endpoint_id, memberships: [{ roomId: 'room_a', role: 'member' }], actorHumanId: actor.human_id, repository, now: NOW,
    })),
    (error) => error.code === 'ROUTE_NOT_AUTHORIZED',
  );
});

test('concurrent transactions naming [a,b] and [b,a] both complete without a deadlock', { skip }, async (t) => {
  const { pool, repository, actor } = await setupRooms(t);
  const targets = [];
  for (const name of ['T1', 'T2']) targets.push(await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: name, wrapKey, now: NOW })));
  const run = (target, order) => withTransaction(pool, async (client) => {
    await addHumanToRoomsTx(client, {
      endpointId: target.endpoint_id, memberships: order.map((roomId) => ({ roomId, role: 'member' })), actorHumanId: actor.human_id, repository, now: NOW,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  const results = await Promise.allSettled([run(targets[0], ['room_a', 'room_b']), run(targets[1], ['room_b', 'room_a'])]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map((r) => r.reason?.code)));
  for (const target of targets) assert.equal((await memberRows(pool, target.endpoint_id)).length, 2);
});

test('lockManagerRows returns only active rows in the named rooms, ordered', { skip }, async (t) => {
  const { pool, actor } = await setupRooms(t, ['room_a', 'room_b', 'room_c']);
  await pool.query(`UPDATE conversation_members SET removed_at = $1 WHERE conversation_id = 'room_c'`, [NOW]);
  const rows = await withTransaction(pool, (client) => lockManagerRows(client, actor.human_id, ['room_b', 'room_a', 'room_c']));
  assert.deepEqual(rows.map((r) => r.conversation_id), ['room_a', 'room_b']);
});
