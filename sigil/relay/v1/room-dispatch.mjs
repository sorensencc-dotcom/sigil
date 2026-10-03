// sigil/relay/v1/room-dispatch.mjs
// Rooms phase 2: who runs next. Every decision to run an agent is a
// room_invocations row. Phase 2's only source is an explicit mention; the
// phase 3 router adds decided_by = 'router'. The relay, not the bridges,
// enforces the loop guards: an agent may post only while it holds a running
// invocation (its post completes it), at most one invocation runs per agent
// per room, and each thread allows max_agent_turns reserved agent turns
// after its latest human message.
import crypto from 'node:crypto';
import { reject } from './validate-envelope.mjs';
import { deliveryBlocker } from './room-policy.mjs';

export function threadRootOf(envelope) {
  return envelope.body?.thread_root_id ?? envelope.message_id;
}

export async function assertAgentMayPost(envelope, senderMember, repository, client) {
  if (senderMember.response_mode === null) return null;
  const running = await repository.lookupRunningInvocation(envelope.conversation_id, envelope.sender.endpoint_id, client);
  if (!running) throw reject('ROOM_NOT_INVOKED', 'Agents may post only while invoked', { conversation_id: envelope.conversation_id });
  if (threadRootOf(envelope) !== running.thread_root_id) {
    throw reject('ROUTE_NOT_AUTHORIZED', 'An agent reply must stay in its invocation thread', { thread_root_id: running.thread_root_id });
  }
  return running;
}

// Moves the oldest queued invocation for (room, agent) to running and writes
// its delivery. Queued rows whose agent can no longer receive are refused, so
// one bad row never blocks the queue.
export async function promoteNextInvocation({ roomId, endpointId, repository, client, now, inboxDepthLimit, registered }) {
  for (;;) {
    const next = await repository.nextQueuedInvocation(roomId, endpointId, client);
    if (!next) return null;
    const blocker = await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered });
    if (blocker) {
      await repository.finishInvocation(next.invocation_id, { status: 'refused', reason: blocker, now }, client);
      continue;
    }
    const deliveryId = await repository.createRoomDelivery({ messageId: next.trigger_message_id, endpointId, now }, client);
    await repository.startInvocation(next.invocation_id, { deliveryId, now }, client);
    return { endpoint_id: endpointId, delivery_id: deliveryId };
  }
}

export async function applyRoomDispatch({ envelope, room, plan, completing, repository, client, now, inboxDepthLimit, registered }) {
  const roomId = room.conversation_id;
  const threadRootId = threadRootOf(envelope);
  const invocations = [];
  const roomDeliveries = [];

  if (plan.senderMember.response_mode === null) await repository.resetAgentTurns(roomId, threadRootId, { now }, client);

  if (completing) {
    await repository.finishInvocation(completing.invocation_id, { status: 'completed', replyMessageId: envelope.message_id, now }, client);
    const promoted = await promoteNextInvocation({ roomId, endpointId: envelope.sender.endpoint_id, repository, client, now, inboxDepthLimit, registered });
    if (promoted) roomDeliveries.push(promoted);
  }

  const agentIds = new Set(plan.agentMembers.map((member) => member.endpoint_id));
  const targets = [...new Set(envelope.body?.mentions ?? [])].filter((id) => agentIds.has(id));
  for (const endpointId of targets) {
    const row = { invocationId: `inv_${crypto.randomUUID()}`, roomId, workspaceId: room.workspace_id, triggerMessageId: envelope.message_id, threadRootId, endpointId, decidedBy: 'mention', now };
    const busy = await repository.lookupRunningInvocation(roomId, endpointId, client);
    const blocker = busy ? null : await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered });
    if (blocker) {
      invocations.push(await repository.createRoomInvocation({ ...row, status: 'refused', reason: blocker }, client));
      continue;
    }
    const turn = await repository.reserveAgentTurn(roomId, threadRootId, room.max_agent_turns, { now }, client);
    if (!turn.allowed) {
      invocations.push(await repository.createRoomInvocation({ ...row, status: 'refused', reason: 'hop_budget' }, client));
      continue;
    }
    if (busy) {
      invocations.push(await repository.createRoomInvocation({ ...row, status: 'queued' }, client));
      continue;
    }
    const deliveryId = await repository.createRoomDelivery({ messageId: envelope.message_id, endpointId, now }, client);
    invocations.push(await repository.createRoomInvocation({ ...row, status: 'running', deliveryId }, client));
    roomDeliveries.push({ endpoint_id: endpointId, delivery_id: deliveryId });
  }
  return { invocations, roomDeliveries };
}
