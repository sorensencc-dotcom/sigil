// Rooms #269 against live PostgreSQL: each hold outcome writes its signed room
// event in the challenge's own transaction, and the expiry sweep writes
// approval_expired once even when two passes race.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';
import { createApprovalRoomHook } from './approval-room-events.mjs';
import { runApprovalExpiryPass } from './approval-expiry-sweep.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date();

test('postgres approval outcomes write signed room events atomically and the sweep writes expiry once', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const run = crypto.randomUUID().replaceAll('-', '_');
  const roomId = `room_${run}`;
  const human = `usr_apv_${run}`;
  const web = `ep_web_${run}`;
  const agent = `ep_agent_${run}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [endpointId, kind] of [[web, 'human'], [agent, 'agent']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $3, $4, $1, 'active', NOW())`,
      [endpointId, human, kind, `install_${endpointId}`],
    );
  }
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [`key_${web}`, web, Buffer.alloc(32, 1)]);
  await pool.query(`INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at) VALUES ($1, $2, 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW())`, [`cred_${run}`, human]);
  const repository = new PostgresRepository({ pool });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `apv_${run}`, createdByHumanId: human, ownerEndpointId: web, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: agent, role: 'member', responseMode: 'joins', addedByHumanId: human, now: NOW });
  const registered = new Map([
    [web, { owner_id: human, status: 'active', kind: 'human' }],
    [agent, { owner_id: human, status: 'active', kind: 'agent' }],
  ]);
  const frames = [];
  const stream = { notifyRoom(endpointId, frame) { frames.push({ endpointId, frame }); } };
  const hook = (outcome, at = NOW) => createApprovalRoomHook({ outcome, repository, systemIdentity: system, registered, stream, now: at });
  const challenge = (id, expiresAt) => ({
    id, endpointId: agent, actionHash: `sha256:${id}`, webauthnChallenge: `wa_${id}`, callbackUrl: 'http://cb.test', token: `tok_${id}`,
    expiresAt: expiresAt.toISOString(), conversationId: roomId, messageId: `msg_held_${id.slice(-4)}`, capabilities: ['payments.send'],
    envelope: { message_id: `msg_held_${id.slice(-4)}` },
  });
  const kinds = async () => (await pool.query(
    `SELECT body->>'kind' AS kind FROM envelopes WHERE conversation_id = $1 AND message_type = 'room.event' ORDER BY room_seq`, [roomId])).rows.map((row) => row.kind);
  const status = async (id) => (await pool.query('SELECT status FROM approval_challenges WHERE challenge_id = $1', [id])).rows[0]?.status;

  // A failed emit rolls the insert back.
  await assert.rejects(repository.createApprovalChallenge(challenge(`chA_${run}`, new Date(NOW.getTime() + 60_000)), { onChange: async () => { throw new Error('emit failed'); } }), /emit failed/);
  assert.equal(await status(`chA_${run}`), undefined);

  // Create and approve: one event each; a failed emit on finalize leaves it pending.
  await repository.createApprovalChallenge(challenge(`chB_${run}`, new Date(NOW.getTime() + 60_000)), { onChange: hook('requested') });
  await assert.rejects(repository.finalizeApprovalDecision({ challengeId: `chB_${run}`, humanId: human, credentialId: `cred_${run}`, endpointId: agent, now: NOW, onChange: async () => { throw new Error('emit failed'); } }), /emit failed/);
  assert.equal(await status(`chB_${run}`), 'pending');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM approval_decisions WHERE nonce = $1', [`chB_${run}`])).rows[0].n, 0);
  await repository.finalizeApprovalDecision({ challengeId: `chB_${run}`, humanId: human, credentialId: `cred_${run}`, endpointId: agent, now: NOW, onChange: hook('granted') });
  assert.equal(await status(`chB_${run}`), 'consumed');

  // Cancel: one event; a repeat cancel writes nothing.
  await repository.createApprovalChallenge(challenge(`chC_${run}`, new Date(NOW.getTime() + 60_000)), { onChange: hook('requested') });
  await repository.cancelApprovalChallenge({ challengeId: `chC_${run}`, endpointId: agent, now: NOW, onChange: hook('cancelled') });
  assert.equal((await repository.cancelApprovalChallenge({ challengeId: `chC_${run}`, endpointId: agent, now: NOW, onChange: hook('cancelled') })).duplicate, true);
  assert.deepEqual(await kinds(), ['approval_requested', 'approval_granted', 'approval_requested', 'approval_cancelled']);

  // Expiry: two passes at once write one approval_expired; the unexpired hold stays pending.
  await repository.createApprovalChallenge(challenge(`chD_${run}`, new Date(NOW.getTime() + 1000)), { onChange: hook('requested') });
  await repository.createApprovalChallenge(challenge(`chE_${run}`, new Date(NOW.getTime() + 600_000)), { onChange: hook('requested') });
  const later = new Date(NOW.getTime() + 5000);
  const results = await Promise.all([1, 2].map(() => runApprovalExpiryPass({ repository, systemIdentity: system, registered, stream, now: later })));
  assert.equal(results[0].expired + results[1].expired, 1);
  assert.equal(await status(`chD_${run}`), 'expired');
  assert.equal(await status(`chE_${run}`), 'pending');
  assert.equal((await kinds()).filter((kind) => kind === 'approval_expired').length, 1);
  const again = await runApprovalExpiryPass({ repository, systemIdentity: system, registered, stream, now: later });
  assert.equal(again.expired, 0);

  // The challenge id never reaches the timeline.
  const wire = (await pool.query(`SELECT body::text || idempotency_key AS wire FROM envelopes WHERE conversation_id = $1`, [roomId])).rows.map((row) => row.wire).join('\n');
  assert.doesNotMatch(wire, /ch[A-E]_/);
  assert.ok(frames.some(({ endpointId, frame }) => endpointId === web && frame.changed === 'approvals'));
  assert.ok(frames.every(({ endpointId }) => endpointId === web));
});
