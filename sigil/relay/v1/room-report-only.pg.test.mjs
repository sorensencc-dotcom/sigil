import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function seed(pool, suffix) {
  const humanId = `usr_report_${suffix}`;
  const ownerEndpointId = `ep_owner_${suffix}`;
  const reporterEndpointId = `ep_report_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  for (const [endpointId, displayName] of [[ownerEndpointId, 'owner'], [reporterEndpointId, 'reporter']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1, $2, 'reporter', 'agent', $3, $4, 'active', NOW())`,
      [endpointId, humanId, `install_${endpointId}`, displayName],
    );
  }
  return { humanId, ownerEndpointId, reporterEndpointId };
}

test('postgres repository stores and restores report_only membership', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_report_${suffix}`;
  await repository.createRoom({
    conversationId: roomId,
    workspaceId: `ws_${ids.humanId}`,
    name: `reports_${suffix}`,
    createdByHumanId: ids.humanId,
    ownerEndpointId: ids.ownerEndpointId,
  });

  const member = await repository.addRoomMember({
    conversationId: roomId,
    endpointId: ids.reporterEndpointId,
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: ids.humanId,
  });
  assert.equal(member.response_mode, 'report_only');
  assert.equal((await repository.lookupRoomMember(roomId, ids.reporterEndpointId)).response_mode, 'report_only');

  await repository.removeRoomMember({ conversationId: roomId, endpointId: ids.reporterEndpointId });
  const restored = await repository.addRoomMember({
    conversationId: roomId,
    endpointId: ids.reporterEndpointId,
    role: 'member',
    responseMode: 'mentions_only',
    addedByHumanId: ids.humanId,
  });
  assert.equal(restored.response_mode, 'mentions_only');
});
