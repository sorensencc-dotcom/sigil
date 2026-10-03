import { reject } from './validate-envelope.mjs';

// Message types a room accepts in phase 1. task.request / task.result are
// deliberately excluded: a broadcast task.request has no single assignee, so
// the task.result assignee binding in accept-envelope.mjs would let any room
// member post a result for any room task. Phase 3 re-adds them together with
// an explicit assignee field.
export const ROOM_MESSAGE_TYPES = new Set(['room.message']);

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
  const senderMember = await repository.lookupRoomMember(room.conversation_id, envelope.sender.endpoint_id, client);
  if (!senderMember) throw reject('ROUTE_NOT_AUTHORIZED', 'Sender is not a room member', details);
  const others = (await repository.listRoomMembers(room.conversation_id, client)).filter((member) => member.endpoint_id !== envelope.sender.endpoint_id);
  const fanout = [];
  const skipped = [];
  for (const member of others) {
    const reason = await deliveryBlocker(member.endpoint_id, repository, client, { inboxDepthLimit, registered });
    if (reason) skipped.push({ endpoint_id: member.endpoint_id, reason });
    else fanout.push(member.endpoint_id);
  }
  for (const skip of skipped) {
    await repository.recordAuditEvent?.({ eventType: 'room.delivery_skipped', subjectId: envelope.message_id, endpointId: skip.endpoint_id, conversationId: room.conversation_id, outcome: 'skipped', reason: skip.reason, now, client });
  }
  return { senderMember, fanout, skipped, agentMembers: others.filter((member) => member.response_mode !== null) };
}

// Returns null when endpointId may receive a room delivery now, otherwise the
// reason it may not. Shared with room-dispatch.mjs for agent deliveries.
export async function deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered }) {
  const endpoint = repository.lookupRecipientEndpoint
    ? (await repository.lookupRecipientEndpoint(endpointId, client)) ?? registered?.get(endpointId)
    : registered?.get(endpointId);
  if (!endpoint || endpoint.status !== 'active') return 'endpoint_inactive';
  if (await repository.countOpenDeliveries(endpointId, client) >= inboxDepthLimit) return 'inbox_full';
  return null;
}
