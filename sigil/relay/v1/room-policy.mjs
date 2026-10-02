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

// Authorizes an envelope addressed to a room and returns the endpoint ids to
// deliver it to. Direct (recipient) envelopes are refused because
// persistAcceptedEnvelope's direct path auto-adds sender and recipient to
// conversation_members, which would let any endpoint join a room uninvited.
export async function authorizeRoomEnvelope(envelope, room, repository, client) {
  const details = { conversation_id: envelope.conversation_id };
  if (envelope.recipient || !envelope.broadcast_scope) throw reject('ROUTE_NOT_AUTHORIZED', 'Room envelopes must use broadcast_scope', details);
  if (envelope.broadcast_scope.conversation_id !== room.conversation_id) throw reject('ROUTE_NOT_AUTHORIZED', 'broadcast_scope must name the room', details);
  if (!ROOM_MESSAGE_TYPES.has(envelope.message_type)) throw reject('ROUTE_NOT_AUTHORIZED', 'Message type is not allowed in rooms', { ...details, message_type: envelope.message_type });
  const sender = await repository.lookupRoomMember(room.conversation_id, envelope.sender.endpoint_id, client);
  if (!sender) throw reject('ROUTE_NOT_AUTHORIZED', 'Sender is not a room member', details);
  const members = await repository.listRoomMembers(room.conversation_id, client);
  return members.map((member) => member.endpoint_id).filter((endpointId) => endpointId !== envelope.sender.endpoint_id);
}
