import crypto from 'node:crypto';
import { lockManagerRows } from '../provision-human.mjs';

const ROLES = new Set(['member', 'room_manager']);
const MANAGER = new Set(['owner', 'room_manager']);
export const hashInviteToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

export async function createInvite(client, { name, createdByHumanId, rooms = [], target = null, ttlMs, now = new Date() }) {
  if (!name) throw fail('INVALID_INVITE', 'invite name is required');
  for (const { role } of rooms) if (!ROLES.has(role)) throw fail('INVALID_ROLE', 'role must be member or room_manager');
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
  for (const { roomId, role } of rooms) {
    await client.query(`INSERT INTO room_invite_rooms (invite_id, room_id, role) VALUES ($1,$2,$3)`, [inviteId, roomId, role]);
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
    state: row.consumed_at ? 'consumed' : row.revoked_at ? 'revoked' : new Date(row.expires_at) <= now ? 'expired' : 'open',
  }));
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
