// sigil/relay/v1/room-routes.mjs
import crypto from 'node:crypto';

const MANAGER_ROLES = new Set(['owner', 'room_manager']);
const GRANTABLE_ROLES = new Set(['room_manager', 'member']);
const RESPONSE_MODES = new Set(['joins', 'mentions_only']);
const ROOM_METHODS = ['createRoom', 'lookupRoom', 'listRoomsForEndpoint', 'addRoomMember', 'removeRoomMember', 'lookupRoomMember', 'listRoomMembers', 'listRoomMessages'];
const NAME_MAX = 80;
const HISTORY_LIMIT_MAX = 500;
const ROOM_SEQ_MAX = 9223372036854775807n; // envelopes.room_seq is int8

function send(response, requestId, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
  response.end(JSON.stringify({ request_id: requestId, ...body }));
  return true;
}

function fail(response, requestId, status, code, message) {
  return send(response, requestId, status, { code, message, details: {} });
}

async function readJson(request, readBody) {
  try { return JSON.parse((await readBody(request, 64 * 1024)) || '{}'); } catch { return null; }
}

// Returns the caller's active membership, or null. Callers answer ROOM_NOT_FOUND
// for both "no such room" and "not a member" so room existence never leaks.
async function membership(repository, roomId, principal) {
  const room = await repository.lookupRoom(roomId);
  if (!room) return null;
  const member = await repository.lookupRoomMember(roomId, principal.endpoint_id);
  return member ? { room, member } : null;
}

export async function handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody }) {
  const path = parsedUrl.pathname;
  if (path !== '/v1/rooms' && !path.startsWith('/v1/rooms/')) return false;
  if (!repository || ROOM_METHODS.some((method) => typeof repository[method] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms are unavailable');

  if (request.method === 'POST' && path === '/v1/rooms') {
    if (!principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    const body = await readJson(request, readBody);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `name must be 1-${NAME_MAX} characters`);
    if (body.description != null && typeof body.description !== 'string') return fail(response, requestId, 400, 'INVALID_REQUEST', 'description must be a string');
    try {
      const room = await repository.createRoom({
        conversationId: `room_${crypto.randomUUID()}`, workspaceId: `ws_${principal.human_id}`, name, description: body.description ?? null,
        createdByHumanId: principal.human_id, ownerEndpointId: principal.endpoint_id, now,
      });
      return send(response, requestId, 201, { code: 'OK', room });
    } catch (error) {
      if (error.code === 'ROOM_NAME_TAKEN') return fail(response, requestId, 409, 'ROOM_NAME_TAKEN', error.message);
      throw error;
    }
  }

  if (request.method === 'GET' && path === '/v1/rooms') {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomsForEndpoint(principal.endpoint_id) });
  }

  const match = path.match(/^\/v1\/rooms\/([^/]+)\/(members|messages)(?:\/([^/]+)\/(remove))?$/);
  if (!match) return false;
  const [, roomId, resource, targetEndpointId, action] = match;
  const access = await membership(repository, roomId, principal);
  if (!access) return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');

  if (request.method === 'GET' && resource === 'members' && !action) {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomMembers(roomId) });
  }

  if (request.method === 'POST' && resource === 'members' && !action) {
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can add members');
    const body = await readJson(request, readBody);
    const endpointId = body?.endpoint_id;
    const role = body?.role ?? 'member';
    const responseMode = body?.response_mode ?? null;
    if (typeof endpointId !== 'string' || !endpointId) return fail(response, requestId, 400, 'INVALID_REQUEST', 'endpoint_id is required');
    if (!GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
    if (responseMode !== null && !RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins or mentions_only');
    const endpoint = registry?.get?.(endpointId);
    if (!endpoint || endpoint.status !== 'active' || endpoint.owner_id !== principal.human_id) {
      return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'You can only add active endpoints you own');
    }
    try {
      const member = await repository.addRoomMember({ conversationId: roomId, endpointId, role, responseMode, addedByHumanId: principal.human_id, now });
      return send(response, requestId, 201, { code: 'OK', member });
    } catch (error) {
      if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', error.message);
      throw error;
    }
  }

  if (request.method === 'POST' && resource === 'members' && action === 'remove') {
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can remove members');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    if (target.role === 'owner') return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'The room owner cannot be removed');
    await repository.removeRoomMember({ conversationId: roomId, endpointId: targetEndpointId, now });
    return send(response, requestId, 200, { code: 'OK', removed: true });
  }

  if (request.method === 'GET' && resource === 'messages' && !action) {
    const afterRaw = parsedUrl.searchParams.get('after_seq') ?? '0';
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq and limit must be non-negative integers');
    if (BigInt(afterRaw) > ROOM_SEQ_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq is out of range');
    const limit = Math.min(Math.max(Number(limitRaw), 1), HISTORY_LIMIT_MAX);
    const items = await repository.listRoomMessages(roomId, BigInt(afterRaw), limit);
    return send(response, requestId, 200, { code: 'OK', items, next_after_seq: items.at(-1)?.room_seq ?? afterRaw });
  }

  return false;
}
