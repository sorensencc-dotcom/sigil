import crypto from 'node:crypto';
import { lockManagerRows } from '../provision-human.mjs';

const ROLES = new Set(['member', 'room_manager']);
const ADMISSIONS = new Set(['direct', 'request']);
const MANAGER = new Set(['owner', 'room_manager']);
export const hashInviteToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

export async function createInvite(client, { name, createdByHumanId, rooms = [], target = null, ttlMs, now = new Date() }) {
  if (!name) throw fail('INVALID_INVITE', 'invite name is required');
  for (const { role } of rooms) if (!ROLES.has(role)) throw fail('INVALID_ROLE', 'role must be member or room_manager');
  // 'direct' (the default, and every CLI invite) adds the member on redeem;
  // 'request' queues a join request for a room manager to decide (#272).
  for (const { admission = 'direct' } of rooms) if (!ADMISSIONS.has(admission)) throw fail('INVALID_ADMISSION', 'admission must be direct or request');
  const roomIds = [...new Set(rooms.map((r) => r.roomId))].sort();
  if (roomIds.length) {
    const locked = await lockManagerRows(client, createdByHumanId, roomIds);
    const managed = new Set(locked.filter((r) => r.owner_id === createdByHumanId && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
    const missing = roomIds.filter((id) => !managed.has(id));
    if (missing.length) throw fail('ROUTE_NOT_AUTHORIZED', `creator does not manage: ${missing.join(', ')}`);
  }
  if (target) {
    const { rows } = await client.query(
      `SELECT e.kind, e.status, e.owner_id FROM endpoints e WHERE e.endpoint_id = $1`, [target.endpointId]);
    const row = rows[0];
    if (!row || row.kind !== 'human' || row.status !== 'active' || row.owner_id !== target.humanId) {
      throw fail('INVALID_TARGET', 'target endpoint must be an active human endpoint owned by the target human');
    }
  }
  const inviteId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const token = crypto.randomBytes(24).toString('base64url'); // 192 bits
  const expires = new Date(now.getTime() + ttlMs);
  await client.query(
    `INSERT INTO room_invites (invite_id, token_hash, name, created_by_human_id, target_human_id, target_endpoint_id, target_issuer, target_subject, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [inviteId, hashInviteToken(token), name, createdByHumanId, target?.humanId ?? null, target?.endpointId ?? null, target?.issuer ?? null, target?.subject ?? null, now.toISOString(), expires.toISOString()]);
  for (const { roomId, role, admission = 'direct' } of rooms) {
    await client.query(`INSERT INTO room_invite_rooms (invite_id, room_id, role, admission) VALUES ($1,$2,$3,$4)`, [inviteId, roomId, role, admission]);
  }
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'invite.created',$2,$2,'room_invite',$3,'success',$4)`,
    [`audit_${crypto.randomUUID()}`, createdByHumanId, inviteId, now.toISOString()]);
  return { invite_id: inviteId, token };
}

export async function listInvites(client, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT i.invite_id, i.name, i.expires_at, i.consumed_at, i.consumed_by_human_id, i.revoked_at,
            COALESCE(json_agg(json_build_object('room_id', r.room_id, 'role', r.role)) FILTER (WHERE r.room_id IS NOT NULL), '[]') AS rooms
       FROM room_invites i LEFT JOIN room_invite_rooms r ON r.invite_id = i.invite_id
      GROUP BY i.invite_id ORDER BY i.created_at DESC`);
  return rows.map((row) => ({
    invite_id: row.invite_id, name: row.name, rooms: row.rooms, expires_at: row.expires_at, consumed_by_human_id: row.consumed_by_human_id,
    state: inviteState(row, now),
  }));
}

const inviteState = (row, now) => (row.consumed_at ? 'consumed' : row.revoked_at ? 'revoked' : new Date(row.expires_at) <= now ? 'expired' : 'open');

// One room's invites for its managers (#272 invite panel). The token is never
// returned; it exists only as a hash after creation.
export async function listRoomInvites(client, { roomId, now = new Date(), limit = 50 }) {
  const { rows } = await client.query(
    `SELECT i.invite_id, i.name, i.created_by_human_id, i.created_at, i.expires_at, i.consumed_at, i.consumed_by_human_id, i.revoked_at,
            r.role, r.admission
       FROM room_invites i JOIN room_invite_rooms r ON r.invite_id = i.invite_id
      WHERE r.room_id = $1
      ORDER BY i.created_at DESC, i.invite_id LIMIT $2`, [roomId, limit]);
  return rows.map((row) => ({
    invite_id: row.invite_id, name: row.name, role: row.role, admission: row.admission, created_by_human_id: row.created_by_human_id,
    created_at: row.created_at, expires_at: row.expires_at, consumed_by_human_id: row.consumed_by_human_id, state: inviteState(row, now),
  }));
}

// Revoke from a room's panel: the invite must name this room, and the actor
// must still manage every room it names, since revoking ends it everywhere.
export async function revokeRoomInvite(client, { roomId, inviteId, actorHumanId, now = new Date() }) {
  const { rows } = await client.query(`SELECT room_id FROM room_invite_rooms WHERE invite_id = $1 ORDER BY room_id`, [inviteId]);
  const roomIds = rows.map((r) => r.room_id);
  if (!roomIds.includes(roomId)) throw fail('INVITE_NOT_FOUND', 'invite not found');
  const locked = await lockManagerRows(client, actorHumanId, roomIds);
  const managed = new Set(locked.filter((r) => r.owner_id === actorHumanId && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
  if (roomIds.some((id) => !managed.has(id))) throw fail('ROUTE_NOT_AUTHORIZED', 'invite also names rooms you do not manage');
  return revokeInvite(client, { inviteId, actorHumanId, now });
}

export async function revokeInvite(client, { inviteId, actorHumanId, now = new Date() }) {
  const { rowCount } = await client.query(
    `UPDATE room_invites SET revoked_at = $2 WHERE invite_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [inviteId, now.toISOString()]);
  if (!rowCount) return { revoked: false };
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'invite.revoked',$2,$2,'room_invite',$3,'success',$4)`,
    [`audit_${crypto.randomUUID()}`, actorHumanId, inviteId, now.toISOString()]);
  return { revoked: true };
}
