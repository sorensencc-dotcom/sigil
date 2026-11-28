// sigil/relay/v1/room-routes.mjs
import crypto from 'node:crypto';
import { emitRoomEvent } from './room-events.mjs';
import { promoteNextInvocation, dispatchToTarget, emitRefusal, emitRoomHalted } from './room-dispatch.mjs';
import { isAgentMember, isRouterMember, memberIsHuman } from './room-policy.mjs';
import { lookupTrustedEntry } from './trusted-endpoint.mjs';
import { clampReason } from '../../contracts/v1/room-event-schema.mjs';
import { notifyRoomHumans } from './room-notify.mjs';
import { sendReceiptFrame } from './receipt-notify.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { validateRoomMessageBody } from '../../contracts/v1/room-message-schema.mjs';
import { createInvite, listRoomInvites, revokeRoomInvite } from './oauth/invites.mjs';
import { listRoomJoinRequests, listOwnJoinRequests, decideJoinRequestTx, withdrawJoinRequestTx } from './join-requests.mjs';

const MANAGER_ROLES = new Set(['owner', 'room_manager']);
const GRANTABLE_ROLES = new Set(['room_manager', 'member']);
const RESPONSE_MODES = new Set(['joins', 'mentions_only', 'router', 'report_only']);
const INVOKABLE_MODES = new Set(['owner', 'members']);
const AGENT_INVITE_TTL_MS = 15 * 60_000;
const ROOM_INVITE_TTL_HOURS_DEFAULT = 24;
const ROOM_INVITE_TTL_HOURS_MAX = 7 * 24;
const ADMISSIONS = new Set(['direct', 'request']);
// Join request queue (#272) error codes and their statuses.
const JOIN_ERRORS = {
  JOIN_REQUEST_NOT_FOUND: [404, 'Join request not found'],
  JOIN_REQUEST_DECIDED: [409, 'Join request was already decided'],
  JOIN_REQUEST_EXPIRED: [409, 'Join request has expired'],
  REQUESTER_INACTIVE: [409, 'The requester is no longer active'],
  ROUTE_NOT_AUTHORIZED: [403, 'Only room owners and room managers can do this'],
  INVALID_REQUEST: [400, 'Invalid request'],
  INVITE_NOT_FOUND: [404, 'Invite not found'],
};
const ROOM_METHODS = ['createRoom', 'lookupRoom', 'listRoomsForEndpoint', 'addRoomMember', 'removeRoomMember', 'lookupRoomMember', 'listRoomMembers', 'listRoomMessages', 'listRoomInvocations', 'lookupRunningInvocation', 'finishInvocation', 'cancelRoomInvocations', 'nextQueuedInvocation', 'startInvocation', 'createRoomDelivery', 'lookupRouterDecision', 'lookupRoomMessage', 'lookupRoomEventByKey', 'lockRoom', 'createRoomInvocation', 'reserveAgentTurn', 'withTransaction', 'acknowledgeRoomDeliveries', 'renameRoom', 'setRoomMemberResponseMode'];
const ROOM_HISTORY_LIMIT_MAX = 100;
const ROOM_SEARCH_QUERY_MIN = 3;
const ROOM_SEARCH_QUERY_MAX = 100;
const ROOM_SEARCH_LIMIT_MAX = 50;
const NAME_MAX = 80;
const HISTORY_LIMIT_MAX = 500;
const ROOM_SEQ_MAX = 9223372036854775807n; // envelopes.room_seq is int8
const MENTIONS_LIMIT_MAX = 100;

function decodeMentionCursor(value) {
  if (value == null) return null;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) return undefined;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(json).toString('base64url') !== value) return undefined;
    const cursor = JSON.parse(json);
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).length !== 3
      || typeof cursor.room_seq !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor.room_seq)
      || typeof cursor.conversation_id !== 'string' || !cursor.conversation_id || cursor.conversation_id.length > 200
      || typeof cursor.message_id !== 'string' || !cursor.message_id || cursor.message_id.length > 200) return undefined;
    if (BigInt(cursor.room_seq) > ROOM_SEQ_MAX) return undefined;
    return cursor;
  } catch {
    return undefined;
  }
}

function encodeMentionCursor(item) {
  return Buffer.from(JSON.stringify({
    room_seq: item.room_seq,
    conversation_id: item.conversation_id,
    message_id: item.message_id,
  })).toString('base64url');
}

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
// The kind comes from repository.lookupTrustedEndpoint (the registry Map only
// when the repository cannot answer).
async function isAgentCaller(repository, registry, principal) {
  if (!principal?.endpoint_id) return false;
  return (await lookupTrustedEntry(repository, registry, principal.endpoint_id))?.kind === 'agent';
}

// The relay-signed human send shared by POST .../messages and POST .../continue,
// so the two cannot drift. `prepare(body)` runs after the replay check and
// returns { messageBody } or { reply: [status, code, message] }.
async function postHumanMessage({ response, requestId, now, principal, repository, registry, humanSigner, buildAcceptOptions, roomId, keyPrefix, body, prepare }) {
  if (!humanSigner) return fail(response, requestId, 503, 'NO_OPERATOR_IDENTITY', 'Human send is not configured (--room-human-identity)');
  if (!buildAcceptOptions) return fail(response, requestId, 503, 'ROOM_SEND_UNAVAILABLE', 'Human send is not available');
  if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.idempotency_key !== 'string' || !body.idempotency_key || body.idempotency_key.length > 128) return fail(response, requestId, 400, 'INVALID_REQUEST', 'idempotency_key is required');
  // The key is scoped to the room, so one key in two rooms never collides.
  const scopedKey = `${keyPrefix}${body.idempotency_key}`;
  const stored = async () => {
    const prior = await repository.lookupIdempotency(principal.endpoint_id, scopedKey);
    if (!prior) return null;
    const row = await repository.lookupRoomMessage(roomId, prior.message_id);
    return row ? { message_id: prior.message_id, room_seq: row.room_seq } : null;
  };
  const replay = await stored();
  if (replay) return send(response, requestId, 200, { code: 'OK', ...replay });
  const prepared = await prepare(body);
  if (prepared.reply) return fail(response, requestId, ...prepared.reply);
  const { messageBody } = prepared;

  let signer;
  try {
    signer = await humanSigner.signForEndpoint(principal.endpoint_id);
  } catch (error) {
    if (error.code === 'NO_SIGNING_KEY') return fail(response, requestId, 403, 'NO_SIGNING_KEY', 'This endpoint cannot post through the relay');
    if (error.code === 'KEY_MISMATCH' || error.code === 'WRAP_KEY_UNAVAILABLE') return fail(response, requestId, 503, error.code, 'Relay signing is unavailable for this endpoint');
    throw error;
  }
  const outbox = new LocalOutbox({ privateKey: signer.privateKey, endpoint: signer.endpoint });
  const created = now instanceof Date ? now : new Date(now);
  const { envelope } = outbox.queue({
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: roomId, message_type: 'room.message',
    sender: { owner_id: signer.endpoint.owner_id, endpoint_id: signer.endpoint.endpoint_id, kind: signer.endpoint.kind },
    broadcast_scope: { conversation_id: roomId }, body: messageBody, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: scopedKey, created_at: created.toISOString(), expires_at: new Date(created.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: signer.endpoint.key_id, value: '' },
  });
  const result = await acceptEnvelopeAsync(envelope, buildAcceptOptions({ request_id: requestId, now }));
  if (result.status === 409 && result.body?.code === 'DUPLICATE_MESSAGE') {
    // A racing retry that lost the idempotency insert (Task 3 translates the
    // repository signal to 409 DUPLICATE_MESSAGE). Re-read the key and answer
    // 200 with the winner; if nothing is stored the 409 is a real conflict.
    const winner = await stored();
    if (winner) return send(response, requestId, 200, { code: 'OK', ...winner });
  }
  // The relay signed with a key its own registry rejects: a relay fault, not the caller's.
  if (result.status === 401 && (result.body?.code === 'UNKNOWN_ENDPOINT' || result.body?.code === 'INVALID_SIGNATURE')) return fail(response, requestId, 500, 'INTERNAL', 'Relay failed to sign the message');
  if (result.status !== 202) return send(response, requestId, result.status, result.body);
  const row = await repository.lookupRoomMessage(roomId, envelope.message_id);
  return send(response, requestId, result.body.duplicate ? 200 : 201, { code: 'OK', message_id: result.body.message_id, room_seq: row?.room_seq ?? null });
}

export async function handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody, stream = null, inboxDepthLimit, systemIdentity = null, logger = null, ticketStore = null, humanSigner = null, buildAcceptOptions = null, resolveRelayOrigin }) {
  const path = parsedUrl.pathname;
  // notifyRoomHumans needs a real client: with client null its member read
  // throws in Postgres mode and no room.updated frame goes out.
  const notifyRoomChange = async (roomId, changed) => {
    try {
      await repository.withTransaction((client) => notifyRoomHumans({ repository, stream, registered: registry, client, roomId, changed, logger: logger ?? console }));
    } catch (error) {
      (logger ?? console)?.error?.('room.updated notify failed', error);
    }
  };
  if (request.method === 'GET' && path === '/v1/mentions') {
    if (!principal?.endpoint_id) return fail(response, requestId, 401, 'UNAUTHENTICATED', 'Authentication required');
    if (typeof repository?.listMentionsForEndpoint !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Mentions are unavailable');
    const requested = Number(parsedUrl.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(requested) ? requested : 50;
    const cursor = decodeMentionCursor(parsedUrl.searchParams.get('cursor'));
    if (cursor === undefined) return fail(response, requestId, 400, 'INVALID_REQUEST', 'cursor is invalid');
    const page = await repository.listMentionsForEndpoint(principal.endpoint_id, Math.min(limit, MENTIONS_LIMIT_MAX), cursor);
    const last = page.hasMore ? page.items.at(-1) : null;
    return send(response, requestId, 200, { code: 'OK', items: page.items, next_cursor: last ? encodeMentionCursor(last) : null });
  }
  if (request.method === 'POST' && path === '/v1/room-agent-invites/redeem') {
    if (!principal?.endpoint_id || !(await isAgentCaller(repository, registry, principal))) return fail(response, requestId, 403, 'AGENT_IDENTITY_REQUIRED', 'An authenticated agent endpoint is required');
    if (['lockRoomAgentInvite', 'consumeRoomAgentInvite', 'withTransaction', 'lookupRoom', 'addRoomMember'].some((method) => typeof repository?.[method] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Agent invites are unavailable');
    const body = await readJson(request, readBody);
    const code = body?.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) return fail(response, requestId, 404, 'INVITE_UNAVAILABLE', 'Invite is invalid, expired, revoked, or already used');
    const endpoint = await lookupTrustedEntry(repository, registry, principal.endpoint_id);
    if (!endpoint || endpoint.kind !== 'agent' || endpoint.status !== 'active' || !endpoint.owner_id || endpoint.owner_id !== principal.owner_id) return fail(response, requestId, 403, 'AGENT_IDENTITY_REQUIRED', 'An active agent endpoint identity is required');
    let member;
    try {
      member = await repository.withTransaction(async (client) => {
        const invite = await repository.lockRoomAgentInvite(crypto.createHash('sha256').update(code).digest('hex'), now, client);
        if (!invite || invite.endpoint_id !== principal.endpoint_id || invite.owner_id !== principal.owner_id) return null;
        const room = await repository.lookupRoom(invite.room_id, client);
        if (!room) return null;
        const joined = await repository.addRoomMember({
          conversationId: invite.room_id, endpointId: principal.endpoint_id, role: 'member', responseMode: 'mentions_only',
          addedByHumanId: invite.created_by_human_id, now,
        }, client);
        if (!await repository.consumeRoomAgentInvite(invite.invite_id, now, client)) throw Object.assign(new Error('Invite is no longer available'), { code: 'INVITE_UNAVAILABLE' });
        return { roomId: invite.room_id, member: joined };
      });
    } catch (error) {
      if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', 'Agent is already connected to this room');
      if (error.code === 'INVITE_UNAVAILABLE') return fail(response, requestId, 404, 'INVITE_UNAVAILABLE', 'Invite is invalid, expired, revoked, or already used');
      throw error;
    }
    if (!member) return fail(response, requestId, 404, 'INVITE_UNAVAILABLE', 'Invite is invalid, expired, revoked, or already used');
    await notifyRoomChange(member.roomId, 'members');
    return send(response, requestId, 200, { code: 'OK', room_id: member.roomId, member: member.member });
  }
  const ownJoin = path === '/v1/join-requests' ? [] : path.match(/^\/v1\/join-requests\/(jreq_[0-9a-f]{32})\/withdraw$/);
  if (ownJoin) {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    if (!repository?.pool || typeof repository.withTransaction !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Join requests are unavailable');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && !ownJoin[1]) {
      const items = await repository.withTransaction((client) => listOwnJoinRequests(client, { humanId: principal.human_id, now }));
      return send(response, requestId, 200, { code: 'OK', items });
    }
    if (request.method === 'POST' && ownJoin[1]) {
      try {
        const withdrawn = await repository.withTransaction((client) => withdrawJoinRequestTx(client, { requestId: ownJoin[1], humanId: principal.human_id, now }));
        await notifyRoomChange(withdrawn.room_id, 'join_requests');
        return send(response, requestId, 200, { code: 'OK', request: withdrawn });
      } catch (error) {
        if (JOIN_ERRORS[error.code]) return fail(response, requestId, JOIN_ERRORS[error.code][0], error.code, error.message);
        throw error;
      }
    }
    return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  if (path.startsWith('/v1/join-requests/')) return fail(response, requestId, 404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
  if (path !== '/v1/rooms' && !path.startsWith('/v1/rooms/')) return false;
  if (request.method === 'POST' && path === '/v1/rooms/ws-ticket') {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    if (!ticketStore) return fail(response, requestId, 503, 'TICKETS_UNAVAILABLE', 'Browser tickets are not configured');
    try {
      const { ticket, expires_at } = ticketStore.issue({ endpoint_id: principal.endpoint_id, owner_id: principal.owner_id, human_id: principal.human_id, session_id: principal.session_id ?? null });
      response.setHeader('cache-control', 'no-store');
      return send(response, requestId, 200, { code: 'OK', ticket, expires_at });
    } catch (error) {
      if (error.code === 'TICKET_CAP') return fail(response, requestId, 429, 'TICKET_CAP', 'Too many outstanding tickets');
      throw error;
    }
  }

  if (!repository || ROOM_METHODS.some((method) => typeof repository[method] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms are unavailable');

  if (request.method === 'POST' && path === '/v1/rooms') {
    if (await isAgentCaller(repository, registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot create rooms');
    if (!principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    // Only the operator creates rooms: the human owning the --room-human-identity
    // endpoint, read from that endpoint's row so every endpoint of theirs qualifies.
    if (!humanSigner) return fail(response, requestId, 503, 'NO_OPERATOR_IDENTITY', 'Room creation is not configured (--room-human-identity)');
    const operator = await lookupTrustedEntry(repository, registry, humanSigner.endpointId);
    if (!operator?.owner_id || operator.status !== 'active' || principal.human_id !== operator.owner_id) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only the operator can create rooms');
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

  const match = path.match(/^\/v1\/rooms\/([^/]+)\/(members|messages|invocations|stop|ack|rename|continue|agent-invites|approvals|keys|invites|join-requests)(?:\/([^/]+)(?:\/(remove|response-mode|invokable-by|revoke|accept|decline))?)?$/);
  if (!match) return false;
  const [, roomId, resource, segment, removeAction] = match;
  // Browsers percent-encode '@' in endpoint IDs (ep_claude%40local); the pathname arrives undecoded.
  let targetEndpointId = segment;
  if (segment !== undefined) {
    try { targetEndpointId = decodeURIComponent(segment); } catch { return fail(response, requestId, 400, 'INVALID_REQUEST', 'Malformed endpoint ID in path'); }
  }
  const action = removeAction;
  const access = await membership(repository, roomId, principal);
  if (!access) return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');

  if (request.method === 'GET' && resource === 'approvals' && !segment) {
    const approvals = await repository.listPendingRoomApprovals?.(roomId, now) ?? [];
    const origin = resolveRelayOrigin?.();
    const items = approvals.map(({ challenge_id, approver_id, approver_name }) => {
      // The ceremony URL itself reveals challenge details, so only send it to the approver.
      const url = origin && principal.human_id === approver_id ? new URL('/approve', origin) : null;
      url?.searchParams.set('challenge', challenge_id);
      return { approver_name, approval_url: url?.href ?? null };
    });
    response.setHeader('cache-control', 'no-store');
    return send(response, requestId, 200, { code: 'OK', items });
  }

  // Public signing keys of one endpoint, for in-browser signature verification. Room members only.
  // The key is the raw 32-byte Ed25519 key (base64url) so a browser can import it as-is.
  if (resource === 'keys') {
    if (request.method !== 'GET' || !segment) return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Use GET /keys/{endpoint_id}');
    const entry = await lookupTrustedEntry(repository, registry, targetEndpointId);
    if (!entry?.keys) return fail(response, requestId, 404, 'ENDPOINT_NOT_FOUND', 'Endpoint not found');
    const keys = [...entry.keys.values()].map((key) => ({
      key_id: key.key_id,
      algorithm: 'Ed25519',
      public_key: (typeof key.public_key?.export === 'function' ? key.public_key : crypto.createPublicKey(key.public_key)).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
      status: key.status,
      valid_from: key.valid_from ?? null,
      valid_until: key.valid_until ?? null,
    }));
    response.setHeader('cache-control', 'no-store');
    return send(response, requestId, 200, { code: 'OK', endpoint_id: targetEndpointId, keys });
  }

  if (resource === 'invites' || resource === 'join-requests') {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room owners and room managers can manage invites and join requests');
    if (!repository.pool) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Invites and join requests are unavailable');
    response.setHeader('cache-control', 'no-store');
    try {
      return await handleAdmissionRoute({ request, response, requestId, now, readBody, principal, repository, registry, roomId, room: access.room, resource, segment, action, systemIdentity, inboxDepthLimit, stream, resolveRelayOrigin, notifyRoomChange });
    } catch (error) {
      if (JOIN_ERRORS[error.code]) return fail(response, requestId, JOIN_ERRORS[error.code][0], error.code, error.message || JOIN_ERRORS[error.code][1]);
      throw error;
    }
  }

  if (resource === 'agent-invites') {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id || !MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can manage agent invites');
    if (typeof repository?.listRoomAgentInvites !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Agent invites are unavailable');
    if (request.method === 'GET' && !segment) {
      return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomAgentInvites(roomId, now) });
    }
    if (request.method === 'POST' && !segment) {
      if (typeof repository?.createRoomAgentInvite !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Agent invites are unavailable');
      const body = await readJson(request, readBody);
      const endpointId = body?.endpoint_id;
      if (typeof endpointId !== 'string' || !endpointId || endpointId.length > 256) return fail(response, requestId, 400, 'INVALID_REQUEST', 'endpoint_id is required');
      const endpoint = await lookupTrustedEntry(repository, registry, endpointId);
      if (!endpoint || endpoint.kind !== 'agent' || endpoint.status !== 'active' || !endpoint.owner_id) return fail(response, requestId, 400, 'INVALID_TARGET', 'Invite target must be an active agent endpoint');
      if (await repository.lookupRoomMember(roomId, endpointId)) return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', 'Agent is already connected to this room');
      const code = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(new Date(now).getTime() + AGENT_INVITE_TTL_MS);
      try {
        const invite = await repository.withTransaction(async (client) => {
          await repository.lockRoom(client, roomId);
          if (await repository.lookupRoomMember(roomId, endpointId, client)) throw Object.assign(new Error('Agent is already connected to this room'), { code: 'ROOM_MEMBER_EXISTS' });
          return repository.createRoomAgentInvite({
            inviteId: `arinv_${crypto.randomBytes(12).toString('hex')}`, roomId, endpointId, ownerId: endpoint.owner_id,
            tokenHash: crypto.createHash('sha256').update(code).digest('hex'), createdByHumanId: principal.human_id,
            now: new Date(now), expiresAt,
          }, client);
        });
        response.setHeader('cache-control', 'no-store');
        return send(response, requestId, 201, { code: 'OK', invite, invite_code: code });
      } catch (error) {
        if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', error.message);
        if (error.code === 'ROOM_AGENT_INVITE_EXISTS') return fail(response, requestId, 409, 'ROOM_AGENT_INVITE_EXISTS', error.message);
        throw error;
      }
    }
    if (request.method === 'POST' && segment && action === 'revoke') {
      if (typeof repository?.revokeRoomAgentInvite !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Agent invites are unavailable');
      const revoked = await repository.revokeRoomAgentInvite(roomId, segment, now);
      if (!revoked) return fail(response, requestId, 404, 'INVITE_NOT_FOUND', 'Pending invite not found');
      return send(response, requestId, 200, { code: 'OK', invite_id: segment, state: 'revoked' });
    }
    return false;
  }

  if (request.method === 'POST' && resource === 'ack' && !segment) {
    const body = await readJson(request, readBody);
    let upTo;
    try { upTo = BigInt(body?.up_to_room_seq); } catch { upTo = null; }
    if (upTo === null || upTo < 0n || upTo > ROOM_SEQ_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', 'up_to_room_seq must be an integer from 0 to 9223372036854775807');
    const moved = await repository.acknowledgeRoomDeliveries({ conversationId: roomId, endpointId: principal.endpoint_id, upToRoomSeq: upTo, now });
    // The repository call committed. sendReceiptFrame isolates its own failures,
    // so a failed sender lookup never turns a committed ack into an error.
    await Promise.all(moved.map((row) => sendReceiptFrame({ stream, repository, logger }, {
      message_id: row.message_id, delivery_id: row.delivery_id, recipient_endpoint_id: principal.endpoint_id,
      state: 'acknowledged', at: now.toISOString(),
    })));
    return send(response, requestId, 200, { code: 'OK', acknowledged: moved.length });
  }

  if (request.method === 'POST' && resource === 'messages' && !segment) {
    const body = await readJson(request, readBody);
    return postHumanMessage({ response, requestId, now, principal, repository, registry, humanSigner, buildAcceptOptions, roomId, keyPrefix: `room:${roomId}:`, body, prepare: (clientBody) => {
      // Only the client's text, thread, and mentions survive: idempotency_key is
      // transport, and a client `sender` is dropped because the relay chooses it.
      const { idempotency_key: _key, sender: _ignoredSender, ...messageBody } = clientBody;
      try { validateRoomMessageBody(messageBody); } catch (error) { return { reply: [400, 'INVALID_ENVELOPE', error.message] }; }
      return { messageBody };
    } });
  }

  if (request.method === 'POST' && resource === 'continue' && !segment) {
    const body = await readJson(request, readBody);
    return postHumanMessage({ response, requestId, now, principal, repository, registry, humanSigner, buildAcceptOptions, roomId, keyPrefix: `room:${roomId}:continue:`, body, prepare: async (clientBody) => {
      const threadRootId = clientBody.thread_root_id;
      if (typeof threadRootId !== 'string' || !threadRootId || threadRootId.length > 128) return { reply: [400, 'INVALID_REQUEST', 'thread_root_id is required'] };
      const refused = await repository.listCapRefusedEndpoints(roomId, threadRootId);
      if (refused.length === 0) return { reply: [409, 'NOTHING_TO_CONTINUE', 'No agent was refused for the turn limit in this thread'] };
      // A human post in the thread refills the budget and mentions re-dispatch
      // the refused agents under the caller, the same as a typed message.
      return { messageBody: { text: 'Continue.', thread_root_id: threadRootId, mentions: refused.slice(0, 10) } };
    } });
  }

  if (request.method === 'GET' && resource === 'members' && !segment) {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomMembers(roomId) });
  }

  if (request.method === 'POST' && resource === 'members' && !segment) {
    if (await isAgentCaller(repository, registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can add members');
    const body = await readJson(request, readBody);
    const endpointId = body?.endpoint_id;
    const role = body?.role ?? 'member';
    const responseMode = body?.response_mode ?? null;
    if (typeof endpointId !== 'string' || !endpointId) return fail(response, requestId, 400, 'INVALID_REQUEST', 'endpoint_id is required');
    if (!GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
    if (responseMode !== null && !RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins, mentions_only, router, or report_only');
    // Owner, status, and kind come from the trusted lookup, never the startup Map.
    const endpoint = await lookupTrustedEntry(repository, registry, endpointId);
    if (!endpoint || endpoint.status !== 'active' || endpoint.owner_id !== principal.human_id || endpoint.kind === 'system') {
      return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'You can only add active endpoints you own');
    }
    const targetIsAgent = endpoint.kind === 'agent';
    if (targetIsAgent && responseMode === null) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode is required for agent endpoints');
    if (!targetIsAgent && responseMode !== null) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode applies only to agent endpoints');
    try {
      const member = await repository.addRoomMember({ conversationId: roomId, endpointId, role, responseMode, addedByHumanId: principal.human_id, now });
      await notifyRoomChange(roomId, 'members');
      return send(response, requestId, 201, { code: 'OK', member });
    } catch (error) {
      if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', error.message);
      throw error;
    }
  }

  if (request.method === 'POST' && resource === 'members' && segment && action === 'remove') {
    if (await isAgentCaller(repository, registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can remove members');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    if (target.role === 'owner') return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'The room owner cannot be removed');
    // A manager removes humans; an agent also needs the caller to own it.
    const targetIsAgent = await repository.withTransaction((client) => isAgentMember(target, repository, client, registry));
    if (targetIsAgent && (!target.owner_id || target.owner_id !== principal.human_id)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', "Only the agent's owner can remove it");
    await repository.withTransaction(async (client) => {
      // Take the rooms row lock first, the same order as accept (assignRoomSequence).
      await repository.lockRoom(client, roomId);
      await repository.removeRoomMember({ conversationId: roomId, endpointId: targetEndpointId, now }, client);
      // A human who leaves the room loses the work they started in it, the
      // way Stop cancels it. Not when another human endpoint of theirs stays.
      if (!target.owner_id || !(await memberIsHuman(target, repository, client, registry))) return;
      for (const member of await repository.listRoomMembers(roomId, client)) {
        if (member.owner_id === target.owner_id && await memberIsHuman(member, repository, client, registry)) return;
      }
      const rows = await repository.cancelRoomInvocations(roomId, { subjectHumanId: target.owner_id, now }, client);
      if (!systemIdentity) return;
      await Promise.all(rows.map(invocation =>
        emitRoomEvent({ identity: systemIdentity, repository, client, room: access.room, body: { kind: 'invocation_stopped', invocation_id: invocation.invocation_id, endpoint_ids: [invocation.endpoint_id], reason: 'stopped' }, idempotencyKey: `evt_stopped_${invocation.invocation_id}`, now, inboxDepthLimit, registered: registry, stream })
      ));
      await emitRoomHalted({ systemIdentity, repository, client, room: access.room, rows, reason: 'left', now, inboxDepthLimit, registered: registry, stream });
    });
    await notifyRoomChange(roomId, 'members');
    return send(response, requestId, 200, { code: 'OK', removed: true });
  }

  if (request.method === 'POST' && resource === 'rename' && !segment) {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can rename the room');
    const body = await readJson(request, readBody);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `name must be 1-${NAME_MAX} characters`);
    if (name === access.room.name) return send(response, requestId, 200, { code: 'OK', room: access.room });
    try {
      const room = await repository.renameRoom({ conversationId: roomId, name });
      await notifyRoomChange(roomId, 'room');
      return send(response, requestId, 200, { code: 'OK', room });
    } catch (error) {
      if (error.code === 'ROOM_NAME_TAKEN') return fail(response, requestId, 409, 'ROOM_NAME_TAKEN', error.message);
      if (error.code === 'ROOM_NOT_FOUND') return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');
      throw error;
    }
  }

  if (request.method === 'POST' && resource === 'members' && segment && action === 'response-mode') {
    if (await isAgentCaller(repository, registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can change response modes');
    const body = await readJson(request, readBody);
    const responseMode = body?.response_mode;
    if (!RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins, mentions_only, router, or report_only');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    // Same agent rule as room dispatch: a phase 1 agent can have a null mode, so response_mode alone is not enough.
    const targetIsAgent = await repository.withTransaction((client) => isAgentMember(target, repository, client, registry));
    if (!targetIsAgent) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode applies only to agent endpoints');
    if (!target.owner_id || target.owner_id !== principal.human_id) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', "Only the agent's owner can change its response mode");
    if (target.response_mode === 'report_only' || responseMode === 'report_only') return fail(response, requestId, 409, 'RESPONSE_MODE_LOCKED', 'report_only response mode can only be set when adding an agent');
    const member = await repository.setRoomMemberResponseMode({ conversationId: roomId, endpointId: targetEndpointId, responseMode });
    if (!member) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    await notifyRoomChange(roomId, 'members');
    return send(response, requestId, 200, { code: 'OK', member });
  }

  // Invocation policy: only the agent's owner may widen or narrow who invokes
  // it. Being a room manager grants no control over an agent's configuration.
  if (request.method === 'POST' && resource === 'members' && segment && action === 'invokable-by') {
    if ((await isAgentCaller(repository, registry, principal)) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (typeof repository.setRoomMemberInvokableBy !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms are unavailable');
    const body = await readJson(request, readBody);
    const invokableBy = body?.invokable_by;
    if (!INVOKABLE_MODES.has(invokableBy)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'invokable_by must be owner or members');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    const targetIsAgent = await repository.withTransaction((client) => isAgentMember(target, repository, client, registry));
    if (!targetIsAgent) return fail(response, requestId, 400, 'INVALID_REQUEST', 'invokable_by applies only to agent endpoints');
    if (!target.owner_id || target.owner_id !== principal.human_id) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', "Only the agent's owner can change who may invoke it");
    const member = await repository.setRoomMemberInvokableBy({ conversationId: roomId, endpointId: targetEndpointId, invokableBy });
    if (!member) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    await notifyRoomChange(roomId, 'members');
    return send(response, requestId, 200, { code: 'OK', member });
  }

  if (request.method === 'GET' && resource === 'messages' && segment === 'search') {
    if (typeof repository.searchRoomMessages !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Room search is unavailable');
    const query = (parsedUrl.searchParams.get('q') ?? '').trim();
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '20';
    const beforeRaw = parsedUrl.searchParams.get('before_seq');
    if (query.length < ROOM_SEARCH_QUERY_MIN || query.length > ROOM_SEARCH_QUERY_MAX) {
      return fail(response, requestId, 400, 'INVALID_REQUEST', `q must be ${ROOM_SEARCH_QUERY_MIN}-${ROOM_SEARCH_QUERY_MAX} characters`);
    }
    if (!/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'limit must be a positive integer');
    if (beforeRaw !== null && (!/^\d+$/.test(beforeRaw) || BigInt(beforeRaw) > ROOM_SEQ_MAX)) {
      return fail(response, requestId, 400, 'INVALID_REQUEST', 'before_seq must be a non-negative room sequence');
    }
    const limit = Math.min(Math.max(Number(limitRaw), 1), ROOM_SEARCH_LIMIT_MAX);
    const found = await repository.searchRoomMessages(roomId, query, beforeRaw === null ? null : BigInt(beforeRaw), limit + 1);
    const hasMore = found.length > limit;
    const items = found.slice(0, limit).map((row) => {
      const text = row.envelope.body.text;
      const matchAt = text.toLocaleLowerCase('en-US').indexOf(query.toLocaleLowerCase('en-US'));
      const start = Math.max(0, matchAt - 80);
      const end = Math.min(text.length, start + 240);
      return {
        room_seq: row.room_seq,
        message_id: row.message_id,
        display_name: row.display_name,
        sender_endpoint_id: row.envelope.sender.endpoint_id,
        created_at: row.envelope.created_at,
        snippet: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
        ...(row.envelope.body.thread_root_id ? { thread_root_id: row.envelope.body.thread_root_id } : {}),
      };
    });
    return send(response, requestId, 200, {
      code: 'OK', items, has_more: hasMore,
      next_before_seq: hasMore ? items.at(-1)?.room_seq ?? null : null,
    });
  }

  if (request.method === 'GET' && resource === 'messages' && !segment) {
    const beforeRaw = parsedUrl.searchParams.get('before_seq');
    if (beforeRaw !== null) {
      if (typeof repository.listRoomMessagesBefore !== 'function') return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Older room history is unavailable');
      const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
      if (beforeRaw !== 'latest' && (!/^\d+$/.test(beforeRaw) || BigInt(beforeRaw) > ROOM_SEQ_MAX)) {
        return fail(response, requestId, 400, 'INVALID_REQUEST', 'before_seq must be latest or a non-negative room sequence');
      }
      if (!/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'limit must be a positive integer');
      const limit = Math.min(Math.max(Number(limitRaw), 1), ROOM_HISTORY_LIMIT_MAX);
      const beforeSeq = beforeRaw === 'latest' ? null : BigInt(beforeRaw);
      const found = await repository.listRoomMessagesBefore(roomId, beforeSeq, limit + 1);
      const hasOlder = found.length > limit;
      const items = hasOlder ? found.slice(-limit) : found;
      return send(response, requestId, 200, {
        code: 'OK', items, has_older: hasOlder,
        next_before_seq: hasOlder ? items[0]?.room_seq ?? null : null,
      });
    }
    const afterRaw = parsedUrl.searchParams.get('after_seq') ?? '0';
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq and limit must be non-negative integers');
    if (BigInt(afterRaw) > ROOM_SEQ_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq is out of range');
    const limit = Math.min(Math.max(Number(limitRaw), 1), HISTORY_LIMIT_MAX);
    const found = await repository.listRoomMessages(roomId, BigInt(afterRaw), limit + 1);
    const hasMore = found.length > limit;
    const items = found.slice(0, limit);
    return send(response, requestId, 200, { code: 'OK', items, has_more: hasMore, next_after_seq: items.at(-1)?.room_seq ?? afterRaw });
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
      // Lock order humans -> endpoints -> rooms, as accept does: FOR SHARE on the
      // trigger sender's endpoint first, so a concurrent suspension waits for this
      // pick and then cancels the invocation it creates.
      const preTrigger = repository.lockEndpointForShare ? await repository.lookupRoomMessage(roomId, triggerId, client) : null;
      if (preTrigger) await repository.lockEndpointForShare(client, preTrigger.envelope.sender.endpoint_id);
      // Serialize per room so a retried decision cannot race its original.
      await repository.lockRoom(client, roomId);
      const trigger = await repository.lookupRoomMessage(roomId, triggerId, client);
      const triggerBody = trigger?.envelope?.body;
      const triggerSender = trigger ? await repository.lookupRoomMember(roomId, trigger.envelope.sender.endpoint_id, client) : null;
      const humanTrigger = trigger && trigger.envelope.message_type === 'room.message' && triggerSender && await memberIsHuman(triggerSender, repository, client, registry);
      if (!humanTrigger || (triggerBody?.mentions ?? []).length > 0) return { invalid: true };
      const decisionKey = `evt_router_${triggerId}`;
      const prior = await repository.lookupRouterDecision(triggerId, client);
      const already = prior.length > 0 || await repository.lookupRoomEventByKey(roomId, `${roomId}:${decisionKey}`, client);
      if (already) return { items: prior, duplicate: true, deliveries: [] };
      const room = await repository.lookupRoom(roomId, client);
      const roster = new Map((await repository.listRoomMembers(roomId, client)).map((member) => [member.endpoint_id, member]));
      const threadRootId = triggerBody?.thread_root_id ?? triggerId;
      // The router is an agent, so the pick runs under the trigger's human sender.
      const subjectHumanId = trigger.envelope.sender.owner_id;
      const items = [];
      const deliveries = [];
      const accepted = [];
      for (const endpointId of [...new Set(invoke)]) {
        const target = roster.get(endpointId);
        let result;
        if (!target || target.response_mode !== 'joins') {
          const refusedRow = { invocationId: `inv_${crypto.randomUUID()}`, roomId, workspaceId: room.workspace_id, triggerMessageId: triggerId, threadRootId, endpointId, decidedBy: 'router', reason: 'not_eligible', status: 'refused', subjectHumanId, now };
          result = { invocation: await repository.createRoomInvocation(refusedRow, client), roomDelivery: null };
        } else {
          // dispatchToTarget applies mayInvoke(subject, target) before any delivery.
          result = await dispatchToTarget({ room, triggerMessageId: triggerId, threadRootId, endpointId, decidedBy: 'router', reason: reason || null, subjectHumanId, target, repository, client, now, inboxDepthLimit, registered: registry });
        }
        items.push(result.invocation);
        if (result.roomDelivery) deliveries.push(result.roomDelivery);
        if (result.invocation.status === 'refused') await emitRefusal({ systemIdentity, repository, client, room, invocation: result.invocation, now, inboxDepthLimit, registered: registry, stream });
        else accepted.push(endpointId);
      }
      await emitRoomEvent({ identity: systemIdentity, repository, client, room, body: { kind: failed ? 'router_failed' : 'router_decision', endpoint_ids: accepted, ...(reason ? { reason } : {}) }, idempotencyKey: decisionKey, now, inboxDepthLimit, registered: registry, stream });
      return { items, duplicate: false, deliveries };
    });
    if (outcome.invalid) return fail(response, requestId, 422, 'INVALID_REQUEST', 'trigger_message_id must name a human room.message without mentions');
    await Promise.all(outcome.deliveries.map((delivery) => {
      stream?.notify?.(delivery.endpoint_id, delivery.delivery_id);
      return sendReceiptFrame({ stream, repository, logger }, { message_id: delivery.message_id, delivery_id: delivery.delivery_id, recipient_endpoint_id: delivery.endpoint_id, state: repository.initialDeliveryState ?? 'delivered', at: now.toISOString() });
    }));
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
      if (systemIdentity) {
        await emitRoomEvent({ identity: systemIdentity, repository, client, room: access.room, body: { kind: 'invocation_failed', invocation_id: running.invocation_id, endpoint_ids: [principal.endpoint_id], reason: clampReason(reason) }, idempotencyKey: `evt_failed_${running.invocation_id}`, now, inboxDepthLimit, registered: registry, stream });
      }
      const promoted = await promoteNextInvocation({ roomId, endpointId: principal.endpoint_id, repository, client, now, inboxDepthLimit, registered: registry, systemIdentity, room: access.room, stream });
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
    const callerIsAgent = (await isAgentCaller(repository, registry, principal)) || await repository.withTransaction((client) => isAgentMember(access.member, repository, client, registry));
    if (callerIsAgent || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Only human members can stop a room');
    const cancelled = await repository.withTransaction(async (client) => {
      // Take the rooms row lock first, the same order as accept (assignRoomSequence).
      await repository.lockRoom(client, roomId);
      // Stop reaches only the caller's own agents and the chains the caller started.
      const rows = await repository.cancelRoomInvocations(roomId, { ownerHumanId: principal.human_id, subjectHumanId: principal.human_id, now }, client);
      if (systemIdentity && rows.length) {
        await Promise.all(rows.map(invocation =>
          emitRoomEvent({ identity: systemIdentity, repository, client, room: access.room, body: { kind: 'invocation_stopped', invocation_id: invocation.invocation_id, endpoint_ids: [invocation.endpoint_id], reason: 'stopped' }, idempotencyKey: `evt_stopped_${invocation.invocation_id}`, now, inboxDepthLimit, registered: registry, stream })
        ));
        await emitRoomHalted({ systemIdentity, repository, client, room: access.room, rows, reason: 'stopped', now, inboxDepthLimit, registered: registry, stream });
      }
      return rows;
    });
    return send(response, requestId, 200, { code: 'OK', cancelled: cancelled.length });
  }

  return false;
}

// Human room invites and the join request queue (#272). The caller is already
// a room owner or room manager here; the decision functions re-check that
// under the room lock.
async function handleAdmissionRoute({ request, response, requestId, now, readBody, principal, repository, registry, roomId, room, resource, segment, action, systemIdentity, inboxDepthLimit, stream, resolveRelayOrigin, notifyRoomChange }) {
  if (resource === 'invites') {
    if (request.method === 'GET' && !segment) {
      const items = await repository.withTransaction((client) => listRoomInvites(client, { roomId, now }));
      return send(response, requestId, 200, { code: 'OK', items });
    }
    if (request.method === 'POST' && !segment) {
      const body = await readJson(request, readBody);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > NAME_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `name must be 1-${NAME_MAX} characters`);
      const role = body.role ?? 'member';
      if (!GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
      // Invites minted here default to the queue; the CLI keeps 'direct'.
      const admission = body.admission ?? 'request';
      if (!ADMISSIONS.has(admission)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'admission must be direct or request');
      const hours = body.ttl_hours ?? ROOM_INVITE_TTL_HOURS_DEFAULT;
      if (!Number.isInteger(hours) || hours < 1 || hours > ROOM_INVITE_TTL_HOURS_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `ttl_hours must be a whole number from 1 to ${ROOM_INVITE_TTL_HOURS_MAX}`);
      const created = await repository.withTransaction((client) => createInvite(client, {
        name, createdByHumanId: principal.human_id, rooms: [{ roomId, role, admission }], ttlMs: hours * 3600_000, now: new Date(now),
      }));
      const origin = resolveRelayOrigin?.();
      // The token is shown once, like `sigil relay invite create`; only its hash is stored.
      return send(response, requestId, 201, { code: 'OK', invite_id: created.invite_id, role, admission, link: origin ? `${origin}/invite#${created.token}` : null, token: created.token });
    }
    if (request.method === 'POST' && segment && action === 'revoke') {
      const result = await repository.withTransaction((client) => revokeRoomInvite(client, { roomId, inviteId: segment, actorHumanId: principal.human_id, now: new Date(now) }));
      return send(response, requestId, 200, { code: 'OK', revoked: result.revoked });
    }
    return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  if (request.method === 'GET' && !segment) {
    const queue = await repository.withTransaction((client) => listRoomJoinRequests(client, { roomId, now }));
    return send(response, requestId, 200, { code: 'OK', ...queue });
  }
  if (request.method === 'POST' && segment && (action === 'accept' || action === 'decline')) {
    if (!/^jreq_[0-9a-f]{32}$/.test(segment)) return fail(response, requestId, 404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found');
    const body = action === 'accept' ? await readJson(request, readBody) : {};
    if (body === null) return fail(response, requestId, 400, 'INVALID_REQUEST', 'Body must be JSON');
    const role = body.role ?? null;
    if (role !== null && !GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
    const decided = await repository.withTransaction(async (client) => {
      const result = await decideJoinRequestTx(client, { repository, roomId, requestId: segment, deciderHumanId: principal.human_id, decision: action, role, now });
      // The signed record of the join (design rule 3), in the same
      // transaction as the membership it records.
      if (result.joined && systemIdentity) {
        const name = result.request.requester_name ?? '';
        await emitRoomEvent({
          identity: systemIdentity, repository, client, room,
          body: { kind: 'member_joined', endpoint_ids: [result.request.requester_endpoint_id], reason: clampReason(`${name || 'Someone'} joined as ${result.request.decided_role === 'room_manager' ? 'room manager' : 'member'}`) },
          idempotencyKey: `evt_joined_${segment}`, now, inboxDepthLimit, registered: registry, stream,
        });
      }
      return result;
    });
    await notifyRoomChange(roomId, 'join_requests');
    if (decided.joined) await notifyRoomChange(roomId, 'members');
    return send(response, requestId, 200, { code: 'OK', request: decided.request, member: decided.member ?? null });
  }
  return fail(response, requestId, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}
