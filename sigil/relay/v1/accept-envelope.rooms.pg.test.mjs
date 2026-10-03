// sigil/relay/v1/accept-envelope.rooms.pg.test.mjs
// Live-Postgres pin for the rooms accept path: concurrent member posts get a
// gapless per-room room_seq inside the accept transaction, non-members and
// removed members are refused with nothing persisted, and the direct persist
// path never enrolls endpoints into a room roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date('2029-12-31T12:01:00.000Z');

async function seed(pool, suffix) {
  const human = `usr_rooms_${suffix}`;
  const endpoints = {};
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const name of ['web', 'claude', 'codex', 'stranger']) {
    const endpointId = `ep_${name}_${suffix}`;
    const keyId = `key_${name}_${suffix}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, human, name, `install_${endpointId}`],
    );
    await pool.query(
      `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
       VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
      [keyId, endpointId, keys.publicKey.export({ type: 'spki', format: 'der' })],
    );
    endpoints[name] = { endpointId, keyId, keys };
  }
  const registered = new Map(Object.values(endpoints).map(({ endpointId, keyId, keys }) => [endpointId, { owner_id: human, status: 'active', key_id: keyId, public_key: keys.publicKey }]));
  return { human, endpoints, registered };
}

function roomEnvelope(world, conversationId, senderName, overrides = {}) {
  const sender = world.endpoints[senderName];
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: conversationId, message_type: 'room.message',
    sender: { endpoint_id: sender.endpointId, owner_id: world.human }, broadcast_scope: { conversation_id: conversationId },
    body: { text: `hello from ${senderName}` }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2029-12-31T12:00:00.000Z', expires_at: '2029-12-31T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: sender.keyId, value: '' },
    ...overrides,
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), sender.keys.privateKey).toString('base64url');
  return envelope;
}

test('postgres accept path: concurrent room posts are gapless, non-members refused, re-added members post again', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const world = await seed(pool, suffix);
  const { web, claude, codex, stranger } = world.endpoints;
  const repository = new PostgresRepository({ pool });
  const conversationId = `room_${suffix}`;
  const accept = (envelope) => acceptEnvelopeAsync(envelope, { repository, registered: world.registered, now: NOW });

  await repository.createRoom({ conversationId, workspaceId: `ws_${world.human}`, name: `build_${suffix}`, createdByHumanId: world.human, ownerEndpointId: web.endpointId, now: NOW });
  await repository.addRoomMember({ conversationId, endpointId: claude.endpointId, role: 'member', responseMode: 'joins', addedByHumanId: world.human, now: NOW });
  await repository.addRoomMember({ conversationId, endpointId: codex.endpointId, role: 'member', responseMode: 'mentions_only', addedByHumanId: world.human, now: NOW });

  // 15 concurrent member posts, 5 per member.
  const senders = ['web', 'claude', 'codex'];
  const envelopes = Array.from({ length: 15 }, (_, i) => roomEnvelope(world, conversationId, senders[i % 3]));
  const results = await Promise.all(envelopes.map(accept));
  assert.deepEqual(results.map((r) => r.status), Array(15).fill(202), JSON.stringify(results.filter((r) => r.status !== 202)));

  const history = await repository.listRoomMessages(conversationId, 0n, 100);
  assert.deepEqual(history.map((m) => m.room_seq), Array.from({ length: 15 }, (_, i) => String(i + 1)), 'room_seq must be exactly 1..15 with no gaps or duplicates');
  assert.deepEqual(new Set(history.map((m) => m.message_id)), new Set(envelopes.map((e) => e.message_id)));
  const deliveries = await pool.query(
    'SELECT count(*)::int AS n FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE e.conversation_id = $1',
    [conversationId],
  );
  assert.equal(deliveries.rows[0].n, 15 * 2, 'each message fans out to the two other members');

  // History carries the stored signed bytes; they verify against the sender key.
  const byId = new Map(envelopes.map((e) => [e.message_id, e]));
  for (const item of history) {
    const original = byId.get(item.message_id);
    assert.equal(item.canonical_bytes, signedBytes(original).toString('base64url'));
    const senderKey = world.registered.get(original.sender.endpoint_id).public_key;
    assert.equal(crypto.verify(null, Buffer.from(item.canonical_bytes, 'base64url'), senderKey, Buffer.from(item.envelope.signature.value, 'base64url')), true);
  }

  // A non-member is refused with 403 and nothing is persisted.
  const intruder = roomEnvelope(world, conversationId, 'stranger');
  const refused = await accept(intruder);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM envelopes WHERE message_id = $1', [intruder.message_id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE message_id = $1', [intruder.message_id])).rows[0].n, 0);

  // A removed member is refused; re-adding them lets them post again, and the
  // rejected attempts left no gap in room_seq.
  assert.equal(await repository.removeRoomMember({ conversationId, endpointId: codex.endpointId, now: NOW }), true);
  const removedPost = await accept(roomEnvelope(world, conversationId, 'codex'));
  assert.equal(removedPost.status, 403);
  assert.equal(removedPost.body.code, 'ROUTE_NOT_AUTHORIZED');
  const readded = await repository.addRoomMember({ conversationId, endpointId: codex.endpointId, role: 'member', responseMode: 'joins', addedByHumanId: world.human, now: NOW });
  assert.equal(readded.endpoint_id, codex.endpointId);
  const back = roomEnvelope(world, conversationId, 'codex');
  const backResult = await accept(back);
  assert.equal(backResult.status, 202, JSON.stringify(backResult));
  const after = await repository.listRoomMessages(conversationId, 15n, 100);
  assert.deepEqual(after.map((m) => [m.room_seq, m.message_id]), [['16', back.message_id]]);

  // Defense in depth: even if a direct envelope for a room conversation
  // reached the persist path, it must not enroll anyone into the roster.
  const rosterBefore = (await repository.listRoomMembers(conversationId)).map((m) => m.endpoint_id).sort();
  const direct = roomEnvelope(world, conversationId, 'web', { message_type: 'chat.message', body: { text: 'direct' }, broadcast_scope: undefined, recipient: { endpoint_id: stranger.endpointId, owner_id: world.human } });
  await repository.withTransaction((client) => repository.persistAcceptedEnvelope({ envelope: direct, canonical_hash: 'h', action_hash: 'h', canonical_bytes: signedBytes(direct), streamSeq: null }, client));
  assert.deepEqual((await repository.listRoomMembers(conversationId)).map((m) => m.endpoint_id).sort(), rosterBefore);
  assert.equal(await repository.lookupRoomMember(conversationId, stranger.endpointId), null);
  const strangerRows = await pool.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2', [conversationId, stranger.endpointId]);
  assert.equal(strangerRows.rows[0].n, 0);
});
