// Room join request queue (#272; design
// docs/superpowers/specs/2026-11-28-sigil-rooms-join-requests-design.md).
// A 'request' invite room queues a pending row at login instead of adding the
// membership; a room owner or room manager then accepts (choosing the role)
// or declines. A request is never membership: nothing here grants access
// until accept inserts the conversation_members row.
import crypto from 'node:crypto';
import { lockManagerRows } from './provision-human.mjs';

export const JOIN_REQUEST_TTL_MS = 7 * 24 * 3600_000;
export const ROOM_PENDING_LIMIT = 50;
export const REQUESTER_PENDING_LIMIT = 20;
export const DECIDED_HISTORY_LIMIT = 50;
const MANAGER = new Set(['owner', 'room_manager']);
const GRANTABLE = new Set(['member', 'room_manager']);

const fail = (code, message) => Object.assign(new Error(message), { code });
const iso = (now) => (now instanceof Date ? now : new Date(now)).toISOString();
const newRequestId = () => `jreq_${crypto.randomBytes(16).toString('hex')}`;

async function audit(client, { type, actorHumanId, requestId, now }) {
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,$2,$3,$3,'room_join_request',$4,'success',$5)`,
    [`audit_${crypto.randomUUID()}`, type, actorHumanId, requestId, iso(now)]);
}

// Expiry is lazy, like room_invites: a pending row past expires_at is written
// as expired the next time its room or requester is touched.
async function expireStale(client, { roomId = null, humanId = null, now }) {
  await client.query(
    `UPDATE room_join_requests SET status = 'expired', decided_at = $3
      WHERE status = 'pending' AND expires_at <= $3 AND (room_id = $1 OR requester_human_id = $2)`,
    [roomId, humanId, iso(now)]);
}

const shape = (row) => ({
  request_id: row.request_id,
  room_id: row.room_id,
  requester_human_id: row.requester_human_id,
  requester_endpoint_id: row.requester_endpoint_id,
  requester_name: row.requester_name ?? null,
  offered_role: row.offered_role,
  status: row.status,
  decided_role: row.decided_role,
  created_at: row.created_at,
  expires_at: row.expires_at,
  decided_at: row.decided_at,
});

// Called inside the login transaction, after the invite is locked and the
// creator re-checked. Queues one pending request per 'request' room; a room
// the human already belongs to, or already has an open request for, is
// skipped. Over a limit, the whole login fails with JOIN_REQUEST_LIMIT so the
// person is told rather than silently dropped.
export async function queueJoinRequestsTx(client, { invite, rooms, humanId, endpointId, now = new Date() }) {
  const queued = [];
  if (!rooms.length) return queued;
  await expireStale(client, { humanId, now });
  for (const { roomId, role } of rooms) {
    await expireStale(client, { roomId, now });
    const { rows: member } = await client.query(
      `SELECT 1 FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id
        WHERE m.conversation_id = $1 AND e.owner_id = $2 AND m.removed_at IS NULL LIMIT 1`, [roomId, humanId]);
    if (member.length) continue;
    const { rows: [counts] } = await client.query(
      `SELECT count(*) FILTER (WHERE room_id = $1)::int AS room_pending,
              count(*) FILTER (WHERE requester_human_id = $2)::int AS requester_pending,
              count(*) FILTER (WHERE room_id = $1 AND requester_human_id = $2)::int AS own_open
         FROM room_join_requests WHERE status = 'pending' AND (room_id = $1 OR requester_human_id = $2)`, [roomId, humanId]);
    if (counts.own_open) continue;
    if (counts.room_pending >= ROOM_PENDING_LIMIT) throw fail('JOIN_REQUEST_LIMIT', 'This room has too many pending join requests');
    if (counts.requester_pending >= REQUESTER_PENDING_LIMIT) throw fail('JOIN_REQUEST_LIMIT', 'You have too many pending join requests');
    const requestId = newRequestId();
    const created = now instanceof Date ? now : new Date(now);
    await client.query(
      `INSERT INTO room_join_requests (request_id, room_id, requester_human_id, requester_endpoint_id, invite_id, offered_role, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [requestId, roomId, humanId, endpointId, invite.invite_id, role, created.toISOString(), new Date(created.getTime() + JOIN_REQUEST_TTL_MS).toISOString()]);
    await audit(client, { type: 'join_request.created', actorHumanId: humanId, requestId, now });
    queued.push({ request_id: requestId, room_id: roomId });
  }
  return queued;
}

// Manager view: pending requests (oldest first), then the most recent decisions.
export async function listRoomJoinRequests(client, { roomId, now = new Date() }) {
  await expireStale(client, { roomId, now });
  const select = `SELECT j.*, e.display_name AS requester_name FROM room_join_requests j
                    LEFT JOIN endpoints e ON e.endpoint_id = j.requester_endpoint_id WHERE j.room_id = $1`;
  const { rows: pending } = await client.query(`${select} AND j.status = 'pending' ORDER BY j.created_at, j.request_id`, [roomId]);
  const { rows: decided } = await client.query(`${select} AND j.status <> 'pending' ORDER BY j.decided_at DESC, j.request_id LIMIT $2`, [roomId, DECIDED_HISTORY_LIMIT]);
  return { pending: pending.map(shape), decided: decided.map(shape) };
}

// Requester view. The room name is shown before accept (Chris, 2026-11-28).
export async function listOwnJoinRequests(client, { humanId, now = new Date() }) {
  await expireStale(client, { humanId, now });
  const { rows } = await client.query(
    `SELECT j.*, r.name AS room_name FROM room_join_requests j JOIN rooms r ON r.conversation_id = j.room_id
      WHERE j.requester_human_id = $1 ORDER BY (j.status = 'pending') DESC, j.created_at DESC LIMIT 100`, [humanId]);
  return rows.map((row) => ({ ...shape(row), room_name: row.room_name }));
}

async function lockRequest(client, { roomId, requestId, now }) {
  const { rows: [row] } = await client.query(
    `SELECT * FROM room_join_requests WHERE request_id = $1 AND room_id = $2 FOR UPDATE`, [requestId, roomId]);
  if (!row) throw fail('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  if (row.status !== 'pending') throw fail('JOIN_REQUEST_DECIDED', 'Join request was already decided');
  if (new Date(row.expires_at) <= (now instanceof Date ? now : new Date(now))) throw fail('JOIN_REQUEST_EXPIRED', 'Join request has expired');
  return row;
}

// Accept or decline. Lock order: rooms row (the order removal and event
// emission use), then the request row, then the decider's and the
// requester's membership rows. The decider is re-checked under those locks,
// so a manager demoted between request and decision is refused.
export async function decideJoinRequestTx(client, { repository, roomId, requestId, deciderHumanId, decision, role = null, now = new Date() }) {
  if (decision !== 'accept' && decision !== 'decline') throw fail('INVALID_REQUEST', 'decision must be accept or decline');
  await repository.lockRoom(client, roomId);
  const request = await lockRequest(client, { roomId, requestId, now });
  const locked = await lockManagerRows(client, deciderHumanId, [roomId], request.requester_endpoint_id);
  if (!locked.some((r) => r.owner_id === deciderHumanId && r.removed_at === null && MANAGER.has(r.role))) {
    throw fail('ROUTE_NOT_AUTHORIZED', 'Only room owners and room managers can decide join requests');
  }
  const ts = iso(now);
  if (decision === 'decline') {
    await client.query(
      `UPDATE room_join_requests SET status = 'declined', decided_by_human_id = $2, decided_at = $3 WHERE request_id = $1`,
      [requestId, deciderHumanId, ts]);
    await audit(client, { type: 'join_request.declined', actorHumanId: deciderHumanId, requestId, now });
    return { request: { ...shape(request), status: 'declined', decided_at: ts }, member: null, joined: false };
  }
  const grantedRole = role ?? request.offered_role;
  if (!GRANTABLE.has(grantedRole)) throw fail('INVALID_REQUEST', 'role must be member or room_manager');
  const h = await client.query(`SELECT status FROM humans WHERE human_id = $1 FOR SHARE`, [request.requester_human_id]);
  const e = await client.query(`SELECT status, kind, owner_id, display_name FROM endpoints WHERE endpoint_id = $1 FOR SHARE`, [request.requester_endpoint_id]);
  if (h.rows[0]?.status !== 'active' || e.rows[0]?.status !== 'active' || e.rows[0]?.kind !== 'human' || e.rows[0]?.owner_id !== request.requester_human_id) {
    throw fail('REQUESTER_INACTIVE', 'The requester is no longer active');
  }
  let member = null;
  try {
    member = await repository.addRoomMember({ conversationId: roomId, endpointId: request.requester_endpoint_id, role: grantedRole, addedByHumanId: deciderHumanId, now }, client);
  } catch (error) {
    if (error.code !== 'ROOM_MEMBER_EXISTS') throw error;
  }
  await client.query(
    `UPDATE room_join_requests SET status = 'accepted', decided_role = $2, decided_by_human_id = $3, decided_at = $4 WHERE request_id = $1`,
    [requestId, grantedRole, deciderHumanId, ts]);
  await audit(client, { type: 'join_request.accepted', actorHumanId: deciderHumanId, requestId, now });
  return { request: { ...shape(request), requester_name: e.rows[0].display_name ?? null, status: 'accepted', decided_role: grantedRole, decided_by_human_id: deciderHumanId, decided_at: ts }, member, joined: member !== null };
}

export async function withdrawJoinRequestTx(client, { requestId, humanId, now = new Date() }) {
  const { rows: [row] } = await client.query(
    `SELECT * FROM room_join_requests WHERE request_id = $1 AND requester_human_id = $2 FOR UPDATE`, [requestId, humanId]);
  if (!row) throw fail('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  if (row.status !== 'pending') throw fail('JOIN_REQUEST_DECIDED', 'Join request was already decided');
  if (new Date(row.expires_at) <= (now instanceof Date ? now : new Date(now))) throw fail('JOIN_REQUEST_EXPIRED', 'Join request has expired');
  const ts = iso(now);
  await client.query(`UPDATE room_join_requests SET status = 'withdrawn', decided_at = $2 WHERE request_id = $1`, [requestId, ts]);
  await audit(client, { type: 'join_request.withdrawn', actorHumanId: humanId, requestId, now });
  return { ...shape(row), status: 'withdrawn', decided_at: ts };
}
