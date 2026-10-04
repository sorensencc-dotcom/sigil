// Rooms phase 3: the relay authors every room.event so it commits atomically
// with the decision it describes and no client can forge one. The envelope is
// signed by the dedicated relay system identity, takes the next room_seq, and
// fans out to human members only (agents never receive events).
import crypto from 'node:crypto';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { identityKeys } from '../../cli/identity.mjs';
import { validateRoomEventBody } from '../../contracts/v1/room-event-schema.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { deliveryBlocker, isAgentMember } from './room-policy.mjs';

const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

export async function emitRoomEvent({ identity, repository, client, room, body, idempotencyKey, now = new Date(), inboxDepthLimit, registered }) {
  validateRoomEventBody(body);
  // Serialize per room, then scope the key to the room: idempotency_keys is keyed
  // (sender endpoint, key) across all rooms, so a raw key reused in two rooms
  // would otherwise pass the lookup and fail the insert.
  await repository.lockRoom(client, room.conversation_id);
  const scopedKey = `${room.conversation_id}:${idempotencyKey}`;
  const existing = await repository.lookupRoomEventByKey(room.conversation_id, scopedKey, client);
  if (existing) return { message_id: existing.message_id, fanout: [], duplicate: true };

  const created = now instanceof Date ? now : new Date(now);
  const outbox = new LocalOutbox({
    privateKey: identityKeys(identity).privateKey,
    endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind },
  });
  const { envelope } = outbox.queue({
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: room.conversation_id,
    message_type: 'room.event',
    broadcast_scope: { conversation_id: room.conversation_id },
    body,
    context_refs: [],
    capabilities: [],
    idempotency_key: scopedKey,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + EVENT_TTL_MS).toISOString(),
  });

  const fanoutIds = [];
  for (const member of await repository.listRoomMembers(room.conversation_id, client)) {
    if (await isAgentMember(member, repository, client, registered)) continue;
    if (!(await deliveryBlocker(member.endpoint_id, repository, client, { inboxDepthLimit, registered }))) fanoutIds.push(member.endpoint_id);
  }
  const roomSeq = await repository.assignRoomSequence(client, room.conversation_id);
  const canonicalBytes = signedBytes(envelope);
  const hash = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
  const persisted = await repository.persistAcceptedEnvelope({
    envelope,
    message_id: envelope.message_id,
    canonical_bytes: canonicalBytes,
    canonical_hash: hash,
    action_hash: hash,
    streamSeq: null,
    roomSeq,
    roomFanout: fanoutIds,
  }, client);
  return { message_id: envelope.message_id, fanout: persisted.fanout ?? [], duplicate: false };
}
