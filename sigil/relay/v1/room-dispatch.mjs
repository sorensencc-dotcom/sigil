// sigil/relay/v1/room-dispatch.mjs
// Rooms phase 2: who runs next. Every decision to run an agent is a
// room_invocations row. Mentions create invocations here; the router member
// receives unmentioned human messages and posts its pick to the invocations
// route (decided_by = 'router'). The relay, not the bridges,
// enforces the loop guards: an agent may post only while it holds a running
// invocation (its post completes it), at most one invocation runs per agent
// per room, and each thread allows max_agent_turns reserved agent turns
// after its latest human message.
import crypto from 'node:crypto';
import { reject } from './validate-envelope.mjs';
import { clampReason } from '../../contracts/v1/room-event-schema.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { deliveryBlocker, endpointIsActive, isInvocableAgent, isRouterMember, memberIsAgent } from './room-policy.mjs';

export function threadRootOf(envelope) {
  return envelope.body?.thread_root_id ?? envelope.message_id;
}

export async function assertAgentMayPost(envelope, senderMember, repository, client) {
  if (!memberIsAgent(senderMember)) return null;
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
export async function emitRefusal({ systemIdentity, repository, client, room, invocation, now, inboxDepthLimit, registered }) {
  if (!systemIdentity) return;
  await emitRoomEvent({
    identity: systemIdentity, repository, client, room,
    body: { kind: 'invocation_refused', invocation_id: invocation.invocation_id, endpoint_ids: [invocation.endpoint_id], reason: clampReason(invocation.reason ?? 'refused') },
    idempotencyKey: `evt_refused_${invocation.invocation_id}`, now, inboxDepthLimit, registered,
  });
}

export async function promoteNextInvocation({ roomId, endpointId, repository, client, now, inboxDepthLimit, registered, systemIdentity = null, room }) {
  for (;;) {
    const next = await repository.nextQueuedInvocation(roomId, endpointId, client);
    if (!next) return null;
    const blocker = await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered });
    if (blocker) {
      await repository.finishInvocation(next.invocation_id, { status: 'refused', reason: blocker, now }, client);
      await emitRefusal({ systemIdentity, repository, client, room, invocation: { invocation_id: next.invocation_id, endpoint_id: endpointId, reason: blocker }, now, inboxDepthLimit, registered });
      continue;
    }
    const deliveryId = await repository.createRoomDelivery({ messageId: next.trigger_message_id, endpointId, now }, client);
    await repository.startInvocation(next.invocation_id, { deliveryId, now }, client);
    return { endpoint_id: endpointId, delivery_id: deliveryId };
  }
}

// One invocation decision for one agent: blocker, hop budget, queue, or run.
// Shared by the mention loop (decidedBy 'mention') and the router route
// ('router'). Callers emit the invocation_refused event for refused rows.
export async function dispatchToTarget({ room, triggerMessageId, threadRootId, endpointId, decidedBy, reason = null, repository, client, now, inboxDepthLimit, registered }) {
  const roomId = room.conversation_id;
  const row = { invocationId: `inv_${crypto.randomUUID()}`, roomId, workspaceId: room.workspace_id, triggerMessageId, threadRootId, endpointId, decidedBy, reason, now };
  const busy = await repository.lookupRunningInvocation(roomId, endpointId, client);
  const blocker = busy ? null : await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered });
  if (blocker) return { invocation: await repository.createRoomInvocation({ ...row, reason: blocker, status: 'refused' }, client), roomDelivery: null };
  const turn = await repository.reserveAgentTurn(roomId, threadRootId, room.max_agent_turns, { now }, client);
  if (!turn.allowed) return { invocation: await repository.createRoomInvocation({ ...row, reason: 'hop_budget', status: 'refused' }, client), roomDelivery: null };
  if (busy) return { invocation: await repository.createRoomInvocation({ ...row, status: 'queued' }, client), roomDelivery: null };
  const deliveryId = await repository.createRoomDelivery({ messageId: triggerMessageId, endpointId, now }, client);
  const invocation = await repository.createRoomInvocation({ ...row, status: 'running', deliveryId }, client);
  return { invocation, roomDelivery: { endpoint_id: endpointId, delivery_id: deliveryId } };
}

export async function applyRoomDispatch({ envelope, room, plan, completing, repository, client, now, inboxDepthLimit, registered, systemIdentity = null }) {
  const roomId = room.conversation_id;
  const threadRootId = threadRootOf(envelope);
  const invocations = [];
  const roomDeliveries = [];

  if (!memberIsAgent(plan.senderMember)) await repository.resetAgentTurns(roomId, threadRootId, { now }, client);

  if (completing) {
    // A concurrent reply may have completed this invocation after the unlocked
    // read in assertAgentMayPost. Throwing rolls back the whole accept transaction.
    const finished = await repository.finishInvocation(completing.invocation_id, { status: 'completed', replyMessageId: envelope.message_id, now }, client);
    if (!finished) throw reject('ROOM_NOT_INVOKED', 'Invocation already completed', { conversation_id: roomId, invocation_id: completing.invocation_id });
    const promoted = await promoteNextInvocation({ roomId, endpointId: envelope.sender.endpoint_id, repository, client, now, inboxDepthLimit, registered, systemIdentity, room });
    if (promoted) roomDeliveries.push(promoted);
  }

  const agentIds = new Set(plan.agentMembers.filter(isInvocableAgent).map((member) => member.endpoint_id));
  const allMentions = [...new Set(envelope.body?.mentions ?? [])];
  const targets = allMentions.filter((id) => agentIds.has(id));
  for (const endpointId of targets) {
    const { invocation, roomDelivery } = await dispatchToTarget({ room, triggerMessageId: envelope.message_id, threadRootId, endpointId, decidedBy: 'mention', repository, client, now, inboxDepthLimit, registered });
    invocations.push(invocation);
    if (roomDelivery) roomDeliveries.push(roomDelivery);
    if (invocation.status === 'refused') await emitRefusal({ systemIdentity, repository, client, room, invocation, now, inboxDepthLimit, registered });
  }
  const routerDeliveries = [];
  const humanSender = !memberIsAgent(plan.senderMember);
  const namesAnAgent = allMentions.some((id) => plan.agentMembers.some((member) => member.endpoint_id === id));
  // Only an active joins agent can pick up the router's invocation.
  let hasJoinedAgent = false;
  if (humanSender && !namesAnAgent) {
    for (const member of plan.agentMembers) {
      if (member.response_mode === 'joins' && await endpointIsActive(member.endpoint_id, repository, client, registered)) { hasJoinedAgent = true; break; }
    }
  }
  // Without a system identity the invocations route answers 503, so a router
  // delivery could never be acked; skip routing instead of retrying forever.
  if (systemIdentity && humanSender && !namesAnAgent && hasJoinedAgent && envelope.message_type === 'room.message') {
    for (const router of plan.agentMembers.filter(isRouterMember)) {
      if (await deliveryBlocker(router.endpoint_id, repository, client, { inboxDepthLimit, registered })) continue;
      const deliveryId = await repository.createRoomDelivery({ messageId: envelope.message_id, endpointId: router.endpoint_id, now }, client);
      routerDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId });
      roomDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId });
    }
  }
  return { invocations, roomDeliveries, routerDeliveries };
}
