import { reject } from './validate-envelope.mjs';

// Room task.request is a broadcast, so the assignee lives on the body. accept-envelope
// binds task.result to body.assignee when the envelope has no recipient.
export const ROOM_MESSAGE_TYPES = new Set(['room.message', 'task.request', 'task.result']);

export function assertRoomTypeHasRoom(envelope, room) {
  if (!room && envelope.message_type.startsWith('room.')) {
    throw reject('INVALID_ENVELOPE', 'room.* message types require a room conversation', { field: 'message_type' });
  }
}

// Rooms are relay-local in phase 1. A forwarded (outbound) or federated
// (inbound) envelope is always direct, and the direct persist path auto-adds
// sender and recipient to conversation_members, so neither path may carry a
// room conversation or a room.* message type.
export function assertNotRoomConversation(envelope, room) {
  if (room) throw reject('ROUTE_NOT_AUTHORIZED', 'Room conversations are not federated', { conversation_id: envelope.conversation_id });
  assertRoomTypeHasRoom(envelope, null);
}

// Authorizes an envelope addressed to a room and decides who receives it.
// Humans receive every room message; agents receive only invoked messages
// (room-dispatch.mjs).
// Direct (recipient) envelopes are refused because persistAcceptedEnvelope's
// direct path auto-adds sender and recipient to conversation_members, which
// would let any endpoint join a room uninvited.
//
// Fan-out eligibility: a revoked or unknown endpoint gets nothing, and a
// recipient whose inbox is at the depth limit is skipped (audited) instead
// of failing the whole room message -- one stuck inbox must not silence the
// room, and every member can catch up from room history.
export async function authorizeRoomEnvelope(envelope, room, repository, client, { inboxDepthLimit, registered, now } = {}) {
  const details = { conversation_id: envelope.conversation_id };
  if (envelope.recipient || !envelope.broadcast_scope) throw reject('ROUTE_NOT_AUTHORIZED', 'Room envelopes must use broadcast_scope', details);
  if (envelope.broadcast_scope.conversation_id !== room.conversation_id) throw reject('ROUTE_NOT_AUTHORIZED', 'broadcast_scope must name the room', details);
  if (!ROOM_MESSAGE_TYPES.has(envelope.message_type)) throw reject('ROUTE_NOT_AUTHORIZED', 'Message type is not allowed in rooms', { ...details, message_type: envelope.message_type });
  const found = await repository.lookupRoomMember(room.conversation_id, envelope.sender.endpoint_id, client);
  if (!found) throw reject('ROUTE_NOT_AUTHORIZED', 'Sender is not a room member', details);
  const senderMember = { ...found, is_agent: await isAgentMember(found, repository, client, registered) };
  const others = [];
  for (const member of await repository.listRoomMembers(room.conversation_id, client)) {
    if (member.endpoint_id !== envelope.sender.endpoint_id) others.push({ ...member, is_agent: await isAgentMember(member, repository, client, registered) });
  }
  if (envelope.message_type === 'task.request') {
    const assignee = envelope.body?.assignee;
    if (typeof assignee !== 'string' || !assignee) {
      throw reject('INVALID_ENVELOPE', 'Room task.request requires body.assignee', { ...details, field: 'assignee' });
    }
    const known = assignee === envelope.sender.endpoint_id || others.some((member) => member.endpoint_id === assignee);
    if (!known) throw reject('ROUTE_NOT_AUTHORIZED', 'task.request assignee is not a room member', { ...details, assignee });
  }
  const humans = others.filter((member) => !member.is_agent);
  const fanout = [];
  const skipped = [];
  for (const member of humans) {
    const reason = await deliveryBlocker(member.endpoint_id, repository, client, { inboxDepthLimit, registered });
    if (reason) skipped.push({ endpoint_id: member.endpoint_id, reason });
    else fanout.push(member.endpoint_id);
  }
  for (const skip of skipped) {
    await repository.recordAuditEvent?.({ eventType: 'room.delivery_skipped', subjectId: envelope.message_id, endpointId: skip.endpoint_id, conversationId: room.conversation_id, outcome: 'skipped', reason: skip.reason, now, client });
  }
  return { senderMember, fanout, skipped, agentMembers: others.filter((member) => member.is_agent).map((member) => ({ ...member, response_mode: member.response_mode ?? 'mentions_only' })) };
}

// The member's endpoint entry: from the repository when it can answer
// (Postgres mode, memory repository), from the registered Map only when the
// repository has no lookupRecipientEndpoint. Never both: a stale Map entry
// must not outvote the endpoints row.
async function memberEndpoint(endpointId, repository, client, registered) {
  return repository.lookupRecipientEndpoint
    ? repository.lookupRecipientEndpoint(endpointId, client)
    : registered?.get?.(endpointId) ?? null;
}

// A member is an agent when it has a response_mode or its endpoint's kind is
// 'agent'. Phase 1 rooms can hold agents with response_mode null (added
// without a mode, or an agent that created the room as owner), so the mode
// alone does not prove a human. A 'system' endpoint is neither agent nor human.
export function isAgentEndpoint(member, entry) {
  return member.response_mode != null || entry?.kind === 'agent';
}

export async function isAgentMember(member, repository, client, registered) {
  if (member.response_mode != null) return true;
  return isAgentEndpoint(member, await memberEndpoint(member.endpoint_id, repository, client, registered));
}

// A human member: kind 'human' and no response_mode. An unknown or missing
// kind is never treated as human.
export async function memberIsHuman(member, repository, client, registered) {
  if (member.response_mode != null) return false;
  return (await memberEndpoint(member.endpoint_id, repository, client, registered))?.kind === 'human';
}

// Room members carry is_agent once authorizeRoomEnvelope has classified them.
export function memberIsAgent(member) {
  return member.is_agent ?? member.response_mode != null;
}

// Whether endpointId may receive a room delivery now. Shared with
// room-dispatch.mjs for agent deliveries.
export async function endpointIsActive(endpointId, repository, client, registered) {
  if (repository.lookupRecipientEndpoint) return (await repository.lookupRecipientEndpoint(endpointId, client))?.status === 'active';
  return registered?.get?.(endpointId)?.status === 'active';
}

export async function deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered }) {
  if (!(await endpointIsActive(endpointId, repository, client, registered))) return 'endpoint_inactive';
  if (await repository.countOpenDeliveries(endpointId, client) >= inboxDepthLimit) return 'inbox_full';
  return null;
}

export function isRouterMember(member) {
  return member.response_mode === 'router';
}

export function isInvocableAgent(member) {
  return member.response_mode === 'joins' || member.response_mode === 'mentions_only';
}
