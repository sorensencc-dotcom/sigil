// Rooms #269: a held room envelope leaves a relay-signed record in the room
// timeline (approval_requested, then approval_granted, approval_cancelled or
// approval_expired) and tells the room's humans to refetch their approvals.
// Each hook runs inside the transaction that changes the challenge row, so the
// record commits with the state change or not at all.
//
// The event names the held envelope by its message_id. The challenge id stays
// out of the event and out of its idempotency key, because both reach every
// room member and the approval page renders a challenge for anyone holding its
// id (#338).
import crypto from 'node:crypto';
import { clampReason } from '../../contracts/v1/room-event-schema.mjs';
import { DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { notifyRoomHumans } from './room-notify.mjs';

const KIND_BY_OUTCOME = {
  requested: 'approval_requested',
  granted: 'approval_granted',
  cancelled: 'approval_cancelled',
  expired: 'approval_expired',
};

// challenge: { challengeId, endpointId, conversationId, messageId, capabilities }.
export function approvalEventBody(outcome, challenge) {
  const kind = KIND_BY_OUTCOME[outcome];
  if (!kind) throw new Error(`Unknown approval outcome: ${outcome}`);
  const reason = clampReason((challenge.capabilities ?? []).join(', '));
  return { kind, endpoint_ids: [challenge.endpointId], held_message_id: challenge.messageId, ...(reason ? { reason } : {}) };
}

// One event per (outcome, challenge). Hashing keeps the key unique per
// challenge, so a message held a second time still gets its own record,
// without putting the challenge id in front of room members.
export function approvalEventKey(outcome, challengeId) {
  const digest = crypto.createHash('sha256').update(String(challengeId)).digest('hex').slice(0, 32);
  return `evt_${KIND_BY_OUTCOME[outcome]}_${digest}`;
}

export function createApprovalRoomHook({ outcome, repository, systemIdentity = null, registered, stream = null, inboxDepthLimit = DEFAULT_INBOX_DEPTH_LIMIT, now = new Date(), logger = console }) {
  if (!KIND_BY_OUTCOME[outcome]) throw new Error(`Unknown approval outcome: ${outcome}`);
  return async (client, challenge) => {
    if (!challenge?.conversationId || !challenge.messageId) return;
    const room = await repository.lookupRoom?.(challenge.conversationId, client);
    if (!room) return;
    if (systemIdentity) {
      await emitRoomEvent({
        identity: systemIdentity, repository, client, room,
        body: approvalEventBody(outcome, challenge),
        idempotencyKey: approvalEventKey(outcome, challenge.challengeId),
        now, inboxDepthLimit, registered, stream, logger,
      });
    }
    await notifyRoomHumans({ repository, stream, registered, client, roomId: room.conversation_id, changed: 'approvals', logger });
  };
}
