// sigil/relay/v1/room-routes.mjs
import crypto from 'node:crypto';
import { emitRoomEvent } from './room-events.mjs';
import { promoteNextInvocation, dispatchToTarget, emitRefusal } from './room-dispatch.mjs';
import { isAgentMember, isRouterMember } from './room-policy.mjs';
import { clampReason } from '../../contracts/v1/room-event-schema.mjs';
import { sendReceiptFrame } from './receipt-notify.mjs';

const MANAGER_ROLES = new Set(['owner', 'room_manager']);
const GRANTABLE_ROLES = new Set(['room_manager', 'member']);
const RESPONSE_MODES = new Set(['joins', 'mentions_only', 'router']);
const ROOM_METHODS = ['createRoom', 'lookupRoom', 'listRoomsForEndpoint', 'addRoomMember', 'removeRoomMember', 'lookupRoomMember', 'listRoomMembers', 'listRoomMessages', 'listRoomInvocations', 'lookupRunningInvocation', 'finishInvocation', 'cancelRoomInvocations', 'nextQueuedInvocation', 'startInvocation', 'createRoomDelivery', 'lookupRouterDecision', 'lookupRoomMessage', 'lookupRoomEventByKey', 'lockRoom', 'createRoomInvocation', 'reserveAgentTurn', 'withTransaction'];
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

// Defense in depth: agent endpoint tokens no longer carry human_id
// (transport-auth.mjs), but a registry entry written before kind existed, or
// a token minted elsewhere, could still pair an agent endpoint with a
// human_id. Room management and Stop therefore also refuse any endpoint the
// registry lists as kind 'agent'.
function isAgentCaller(registry, principal) {
  return registry?.get?.(principal?.endpoint_id)?.kind === 'agent';
}

export async function handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody, stream = null, inboxDepthLimit, systemIdentity = null, logger = null }) {
  const path = parsedUrl.pathname;
  if (path !== '/v1/rooms' && !path.startsWith('/v1/rooms/')) return false;
  if (!repository || ROOM_METHODS.some((method) => typeof repository[method] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms are unavailable');

  if (request.method === 'POST' && path === '/v1/rooms') {
    if (isAgentCaller(registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot create rooms');
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

  const match = path.match(/^\/v1\/rooms\/([^/]+)\/(members|messages|invocations|stop)(?:\/([^/]+)(?:\/(remove))?)?$/);
  if (!match) return false;
  const [, roomId, resource, segment, removeAction] = match;
  const targetEndpointId = segment;
  const action = removeAction;
  const access = await membership(repository, roomId, principal);
  if (!access) return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');

  if (request.method === 'GET' && resource === 'members' && !segment) {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomMembers(roomId) });
  }

  if (request.method === 'POST' && resource === 'members' && !segment) {
    if (isAgentCaller(registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can add members');
    const body = await readJson(request, readBody);
    const endpointId = body?.endpoint_id;
    const role = body?.role ?? 'member';
    const responseMode = body?.response_mode ?? null;
    if (typeof endpointId !== 'string' || !endpointId) return fail(response, requestId, 400, 'INVALID_REQUEST', 'endpoint_id is required');
    if (!GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
    if (responseMode !== null && !RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins, mentions_only, or router');
    const endpoint = registry?.get?.(endpointId);
    if (!endpoint || endpoint.status !== 'active' || endpoint.owner_id !== principal.human_id) {
      return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'You can only add active endpoints you own');
    }
    const targetIsAgent = endpoint.kind === 'agent';
    if (targetIsAgent && responseMode === null) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode is required for agent endpoints');
    if (!targetIsAgent && responseMode !== null) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode applies only to agent endpoints');
    try {
      const member = await repository.addRoomMember({ conversationId: roomId, endpointId, role, responseMode, addedByHumanId: principal.human_id, now });
      return send(response, requestId, 201, { code: 'OK', member });
    } catch (error) {
      if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', error.message);
      throw error;
    }
  }

  if (request.method === 'POST' && resource === 'members' && segment && action === 'remove') {
    if (isAgentCaller(registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can remove members');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    if (target.role === 'owner') return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'The room owner cannot be removed');
    await repository.removeRoomMember({ conversationId: roomId, endpointId: targetEndpointId, now });
    return send(response, requestId, 200, { code: 'OK', removed: true });
  }

  if (request.method === 'GET' && resource === 'messages' && !segment) {
    const afterRaw = parsedUrl.searchParams.get('after_seq') ?? '0';
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq and limit must be non-negative integers');
    if (BigInt(afterRaw) > ROOM_SEQ_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq is out of range');
    const limit = Math.min(Math.max(Number(limitRaw), 1), HISTORY_LIMIT_MAX);
    const items = await repository.listRoomMessages(roomId, BigInt(afterRaw), limit);
    return send(response, requestId, 200, { code: 'OK', items, next_after_seq: items.at(-1)?.room_seq ?? afterRaw });
  }

  if (request.method === 'GET' && resource === 'invocations' && !segment) {
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'limit must be a non-negative integer');
    const items = await repository.listRoomInvocations(roomId, {
      endpointId: parsedUrl.searchParams.get('endpoint_id'), status: parsedUrl.searchParams.get('status'),
      limit: Math.min(Math.max(Number(limitRaw), 1), HISTORY_LIMIT_MAX),
    });
    return send(response, requestId, 200, { code: 'OK', items });
  }

  if (request.method === 'POST' && resource === 'invocations' && !segment) {
    // The router's pick is advisory: every endpoint is re-validated here.
    if (!isRouterMember(access.member)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only the room router can create invocations');
    if (!systemIdentity) return fail(response, requestId, 503, 'ROOM_EVENTS_UNAVAILABLE', 'The relay has no room system identity');
    const body = await readJson(request, readBody);
    const triggerId = body?.trigger_message_id;
    const invoke = body?.invoke;
    if (body?.failed !== undefined && typeof body.failed !== 'boolean') return fail(response, requestId, 400, 'INVALID_REQUEST', 'failed must be a boolean');
    const failed = body?.failed === true;
    if (typeof triggerId !== 'string' || !triggerId) return fail(response, requestId, 400, 'INVALID_REQUEST', 'trigger_message_id required');
    if (!Array.isArray(invoke) || invoke.length > 10 || invoke.some((id) => typeof id !== 'string' || !id)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'invoke must be an array of at most 10 endpoint ids');
    if (failed && invoke.length > 0) return fail(response, requestId, 400, 'INVALID_REQUEST', 'failed decisions cannot invoke agents');
    const reason = clampReason(body?.reason);
    const outcome = await repository.withTransaction(async (client) => {
      // Serialize per room so a retried decision cannot race its original.
      await repository.lockRoom(client, roomId);
      const trigger = await repository.lookupRoomMessage(roomId, triggerId, client);
      const triggerBody = trigger?.envelope?.body;
      const triggerSender = trigger ? await repository.lookupRoomMember(roomId, trigger.envelope.sender.endpoint_id, client) : null;
      const humanTrigger = trigger && trigger.envelope.message_type === 'room.message' && triggerSender && !(await isAgentMember(triggerSender, repository, client, registry));
      if (!humanTrigger || (triggerBody?.mentions ?? []).length > 0) return { invalid: true };
      const decisionKey = `evt_router_${triggerId}`;
      const prior = await repository.lookupRouterDecision(triggerId, client);
      const already = prior.length > 0 || await repository.lookupRoomEventByKey(roomId, `${roomId}:${decisionKey}`, client);
      if (already) return { items: prior, duplicate: true, deliveries: [] };
      const room = await repository.lookupRoom(roomId, client);
      const roster = new Map((await repository.listRoomMembers(roomId, client)).map((member) => [member.endpoint_id, member]));
      const threadRootId = triggerBody?.thread_root_id ?? triggerId;
      const items = [];
      const deliveries = [];
      const accepted = [];
      for (const endpointId of [...new Set(invoke)]) {
        const target = roster.get(endpointId);
        let result;
        if (!target || target.response_mode !== 'joins') {
          const refusedRow = { invocationId: `inv_${crypto.randomUUID()}`, roomId, workspaceId: room.workspace_id, triggerMessageId: triggerId, threadRootId, endpointId, decidedBy: 'router', reason: 'not_eligible', status: 'refused', now };
          result = { invocation: await repository.createRoomInvocation(refusedRow, client), roomDelivery: null };
        } else {
          result = await dispatchToTarget({ room, triggerMessageId: triggerId, threadRootId, endpointId, decidedBy: 'router', reason: reason || null, repository, client, now, inboxDepthLimit, registered: registry });
        }
        items.push(result.invocation);
        if (result.roomDelivery) deliveries.push(result.roomDelivery);
        if (result.invocation.status === 'refused') await emitRefusal({ systemIdentity, repository, client, room, invocation: result.invocation, now, inboxDepthLimit, registered: registry });
        else accepted.push(endpointId);
      }
      await emitRoomEvent({ identity: systemIdentity, repository, client, room, body: { kind: failed ? 'router_failed' : 'router_decision', endpoint_ids: accepted, ...(reason ? { reason } : {}) }, idempotencyKey: decisionKey, now, inboxDepthLimit, registered: registry });
      return { items, duplicate: false, deliveries };
    });
    if (outcome.invalid) return fail(response, requestId, 422, 'INVALID_REQUEST', 'trigger_message_id must name a human room.message without mentions');
    for (const delivery of outcome.deliveries) {
      stream?.notify?.(delivery.endpoint_id, delivery.delivery_id);
      await sendReceiptFrame({ stream, repository, logger }, { message_id: delivery.message_id, delivery_id: delivery.delivery_id, recipient_endpoint_id: delivery.endpoint_id, state: repository.initialDeliveryState ?? 'delivered', at: now.toISOString() });
    }
    return send(response, requestId, 200, { code: 'OK', items: outcome.items, duplicate: outcome.duplicate });
  }

  if (request.method === 'POST' && resource === 'invocations' && segment === 'fail' && !action) {
    const body = await readJson(request, readBody);
    if (body?.invocation_id != null && typeof body.invocation_id !== 'string') return fail(response, requestId, 400, 'INVALID_REQUEST', 'invocation_id must be a string');
    const expectedId = body?.invocation_id ?? null;
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : 'bridge_failed';
    const outcome = await repository.withTransaction(async (client) => {
      // Take the rooms row lock first, the same order as accept (assignRoomSequence).
      await repository.lockRoom(client, roomId);
      const running = await repository.lookupRunningInvocation(roomId, principal.endpoint_id, client);
      if (!running) return null;
      // A late failure from an older bridge turn must not fail a newer invocation.
      if (expectedId !== null && running.invocation_id !== expectedId) return null;
      const invocation = await repository.finishInvocation(running.invocation_id, { status: 'failed', reason, now }, client);
      const promoted = await promoteNextInvocation({ roomId, endpointId: principal.endpoint_id, repository, client, now, inboxDepthLimit, registered: registry, systemIdentity, room: access.room });
      return { invocation, promoted };
    });
    if (!outcome) return fail(response, requestId, 404, 'INVOCATION_NOT_FOUND', 'No matching running invocation for this endpoint in this room');
    if (outcome.promoted) {
      stream?.notify?.(outcome.promoted.endpoint_id, outcome.promoted.delivery_id);
      await sendReceiptFrame({ stream, repository, logger }, { message_id: outcome.promoted.message_id, delivery_id: outcome.promoted.delivery_id, recipient_endpoint_id: outcome.promoted.endpoint_id, state: repository.initialDeliveryState ?? 'delivered', at: now.toISOString() });
    }
    return send(response, requestId, 200, { code: 'OK', invocation: outcome.invocation });
  }

  if (request.method === 'POST' && resource === 'stop' && !segment) {
    // Same agent rule as room dispatch (room-policy.mjs isAgentMember):
    // response_mode set, or the registry or endpoints row says kind 'agent'.
    const callerIsAgent = isAgentCaller(registry, principal) || await repository.withTransaction((client) => isAgentMember(access.member, repository, client, registry));
    if (callerIsAgent) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Only human members can stop a room');
    const cancelled = await repository.withTransaction(async (client) => {
      // Take the rooms row lock first, the same order as accept (assignRoomSequence).
      await repository.lockRoom(client, roomId);
      const rows = await repository.cancelRoomInvocations(roomId, { now }, client);
      if (systemIdentity && rows.length) {
        for (const invocation of rows) {
          await emitRoomEvent({ identity: systemIdentity, repository, client, room: access.room, body: { kind: 'invocation_stopped', invocation_id: invocation.invocation_id, endpoint_ids: [invocation.endpoint_id], reason: 'stopped' }, idempotencyKey: `evt_stopped_${invocation.invocation_id}`, now, inboxDepthLimit, registered: registry });
        }
      }
      return rows;
    });
    return send(response, requestId, 200, { code: 'OK', cancelled: cancelled.length });
  }

  return false;
}
