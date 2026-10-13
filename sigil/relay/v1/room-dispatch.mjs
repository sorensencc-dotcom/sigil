// sigil/relay/v1/room-dispatch.mjs
// Rooms phase 2: who runs next. Every decision to run an agent is a
// room_invocations row. Mentions create invocations here; the router member
// receives unmentioned human messages and posts its pick to the invocations
// route (decided_by = 'router'). The relay, not the bridges,
// enforces the loop guards: an agent may post only while it holds a running
// invocation (its post completes it), at most one invocation runs per agent
// per room, and each thread allows max_agent_turns reserved agent turns
// after its latest human message.
//
// Invocation policy (multi-human foundation): every row carries the human
// whose authority it runs under (subject_human_id), and mayInvoke(subject,
// target) gates every dispatch site: mention, assignee, router pick, router
// delivery, and queued-row promotion.
import crypto from 'node:crypto';
import { reject } from './validate-envelope.mjs';
import { clampReason } from '../../contracts/v1/room-event-schema.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { mayInvoke } from './invoke-policy.mjs';
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

// The human an envelope's dispatch runs under: a human sender is their own
// subject; an agent sender inherits the subject of the invocation it is
// completing, so the subject survives every hop.
export function dispatchSubject(envelope, senderMember, completing) {
  return memberIsAgent(senderMember) ? completing?.subject_human_id ?? null : envelope.sender?.owner_id ?? null;
}

function refusalText(invocation) {
  if (invocation.reason === 'not_allowed') return `not allowed to invoke ${invocation.endpoint_id}`;
  return invocation.reason ?? 'refused';
}

// The one refusal path: a room.event (when the relay has a system identity)
// and a room.invocation_refused audit row (always). Refusals never drop silently.
export async function emitRefusal({ systemIdentity, repository, client, room, invocation, now, inboxDepthLimit, registered, stream = null }) {
  await repository.recordAuditEvent?.({
    eventType: 'room.invocation_refused', subjectId: invocation.invocation_id, actorHumanId: invocation.subject_human_id ?? null,
    endpointId: invocation.endpoint_id, conversationId: room.conversation_id, objectType: 'room_invocation', objectId: invocation.invocation_id,
    outcome: 'refused', reason: invocation.reason ?? 'refused', now, client,
  });
  if (!systemIdentity) return;
  await emitRoomEvent({
    identity: systemIdentity, repository, client, room,
    body: { kind: 'invocation_refused', invocation_id: invocation.invocation_id, endpoint_ids: [invocation.endpoint_id], reason: clampReason(refusalText(invocation)) },
    idempotencyKey: `evt_refused_${invocation.invocation_id}`, now, inboxDepthLimit, registered, stream,
  });
}

// Why a queued row may no longer start, or null. The subject must still be an
// active human with an active endpoint in the room, and still pass mayInvoke
// against the agent's current member row.
async function subjectBlocker(roomId, endpointId, subjectHumanId, repository, client) {
  const subject = subjectHumanId ? await repository.lookupInvocationSubject(roomId, subjectHumanId, client) : null;
  if (!subject || subject.status !== 'active') return 'subject_inactive';
  if (!subject.is_member) return 'subject_removed';
  const target = await repository.lookupRoomMember(roomId, endpointId, client);
  if (!mayInvoke(subjectHumanId, target)) return 'not_allowed';
  return null;
}

// Moves the oldest queued invocation for (room, agent) to running and writes
// its delivery. Queued rows whose agent can no longer receive, or whose
// subject may no longer invoke it, are refused, so one bad row never blocks the queue.
export async function promoteNextInvocation({ roomId, endpointId, repository, client, now, inboxDepthLimit, registered, systemIdentity = null, room, stream = null }) {
  for (;;) {
    const next = await repository.nextQueuedInvocation(roomId, endpointId, client);
    if (!next) return null;
    const blocker = await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered })
      ?? await subjectBlocker(roomId, endpointId, next.subject_human_id, repository, client);
    if (blocker) {
      await repository.finishInvocation(next.invocation_id, { status: 'refused', reason: blocker, now }, client);
      await emitRefusal({ systemIdentity, repository, client, room, invocation: { invocation_id: next.invocation_id, endpoint_id: endpointId, subject_human_id: next.subject_human_id, reason: blocker }, now, inboxDepthLimit, registered, stream });
      continue;
    }
    const deliveryId = await repository.createRoomDelivery({ messageId: next.trigger_message_id, endpointId, now }, client);
    await repository.startInvocation(next.invocation_id, { deliveryId, now }, client);
    return { endpoint_id: endpointId, delivery_id: deliveryId, message_id: next.trigger_message_id };
  }
}

// One invocation decision for one agent: policy, blocker, hop budget, queue,
// or run. Shared by the mention loop (decidedBy 'mention'), the assignee, and
// the router route ('router'). `target` is the agent's member row; it is read
// when the caller does not pass one. Callers emit the refusal for refused rows.
export async function dispatchToTarget({ room, triggerMessageId, threadRootId, endpointId, decidedBy, reason = null, subjectHumanId, target, repository, client, now, inboxDepthLimit, registered }) {
  const roomId = room.conversation_id;
  const row = { invocationId: `inv_${crypto.randomUUID()}`, roomId, workspaceId: room.workspace_id, triggerMessageId, threadRootId, endpointId, decidedBy, reason, subjectHumanId, now };
  const member = target ?? await repository.lookupRoomMember(roomId, endpointId, client);
  if (!mayInvoke(subjectHumanId, member)) return { invocation: await repository.createRoomInvocation({ ...row, reason: 'not_allowed', status: 'refused' }, client), roomDelivery: null };
  const busy = await repository.lookupRunningInvocation(roomId, endpointId, client);
  const blocker = busy ? null : await deliveryBlocker(endpointId, repository, client, { inboxDepthLimit, registered });
  if (blocker) return { invocation: await repository.createRoomInvocation({ ...row, reason: blocker, status: 'refused' }, client), roomDelivery: null };
  const turn = await repository.reserveAgentTurn(roomId, threadRootId, room.max_agent_turns, { now }, client);
  if (!turn.allowed) return { invocation: await repository.createRoomInvocation({ ...row, reason: 'hop_budget', status: 'refused' }, client), roomDelivery: null };
  if (busy) return { invocation: await repository.createRoomInvocation({ ...row, status: 'queued' }, client), roomDelivery: null };
  const deliveryId = await repository.createRoomDelivery({ messageId: triggerMessageId, endpointId, now }, client);
  const invocation = await repository.createRoomInvocation({ ...row, status: 'running', deliveryId }, client);
  return { invocation, roomDelivery: { endpoint_id: endpointId, delivery_id: deliveryId, message_id: triggerMessageId } };
}

export async function applyRoomDispatch({ envelope, room, plan, completing, repository, client, now, inboxDepthLimit, registered, systemIdentity = null, stream = null }) {
  const roomId = room.conversation_id;
  const threadRootId = threadRootOf(envelope);
  const invocations = [];
  const roomDeliveries = [];
  const humanSender = !memberIsAgent(plan.senderMember);
  const subject = dispatchSubject(envelope, plan.senderMember, completing);

  // A human post refills the thread's hop budget only when they are the
  // subject of every invocation still active in it, so a guest cannot refill
  // the budget of a chain started under someone else's authority.
  if (humanSender) {
    const active = await repository.listActiveThreadSubjects(roomId, threadRootId, client);
    if (active.every((id) => id === subject)) await repository.resetAgentTurns(roomId, threadRootId, { now }, client);
  }

  if (completing) {
    // A concurrent reply may have completed this invocation after the unlocked
    // read in assertAgentMayPost. Throwing rolls back the whole accept transaction.
    const finished = await repository.finishInvocation(completing.invocation_id, { status: 'completed', replyMessageId: envelope.message_id, now }, client);
    if (!finished) throw reject('ROOM_NOT_INVOKED', 'Invocation already completed', { conversation_id: roomId, invocation_id: completing.invocation_id });
    const promoted = await promoteNextInvocation({ roomId, endpointId: envelope.sender.endpoint_id, repository, client, now, inboxDepthLimit, registered, systemIdentity, room, stream });
    if (promoted) roomDeliveries.push(promoted);
  }

  const agents = new Map(plan.agentMembers.filter(isInvocableAgent).map((member) => [member.endpoint_id, member]));
  const dispatch = async (endpointId, decidedBy) => {
    const { invocation, roomDelivery } = await dispatchToTarget({ room, triggerMessageId: envelope.message_id, threadRootId, endpointId, decidedBy, subjectHumanId: subject, target: agents.get(endpointId), repository, client, now, inboxDepthLimit, registered });
    invocations.push(invocation);
    if (roomDelivery) roomDeliveries.push(roomDelivery);
    if (invocation.status === 'refused') await emitRefusal({ systemIdentity, repository, client, room, invocation, now, inboxDepthLimit, registered, stream });
  };
  const allMentions = [...new Set(envelope.body?.mentions ?? [])];
  const targets = allMentions.filter((id) => agents.has(id));
  for (const endpointId of targets) await dispatch(endpointId, 'mention');
  const assignee = envelope.message_type === 'task.request' && typeof envelope.body?.assignee === 'string' ? envelope.body.assignee : null;
  if (assignee && agents.has(assignee) && !targets.includes(assignee)) await dispatch(assignee, 'assignee');

  const routerDeliveries = [];
  // Any mention keeps the message off the router: the invocations route answers
  // 422 for a trigger with mentions, so routing it would only waste a model call.
  const noMentions = allMentions.length === 0;
  // Only an active joins agent the sender may invoke can pick up the router's
  // invocation, so a guest who may invoke none costs no router model call.
  let hasJoinedAgent = false;
  if (humanSender && noMentions) {
    for (const member of plan.agentMembers) {
      if (member.response_mode === 'joins' && mayInvoke(subject, member) && await endpointIsActive(member.endpoint_id, repository, client, registered)) { hasJoinedAgent = true; break; }
    }
  }
  // Without a system identity the invocations route answers 503, so a router
  // delivery could never be acked; skip routing instead of retrying forever.
  if (systemIdentity && humanSender && noMentions && hasJoinedAgent && envelope.message_type === 'room.message') {
    // The router is itself an invocation target: it runs only for a sender who may invoke it.
    for (const router of plan.agentMembers.filter((member) => isRouterMember(member) && mayInvoke(subject, member))) {
      if (await deliveryBlocker(router.endpoint_id, repository, client, { inboxDepthLimit, registered })) continue;
      const deliveryId = await repository.createRoomDelivery({ messageId: envelope.message_id, endpointId: router.endpoint_id, now }, client);
      routerDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId, message_id: envelope.message_id });
      roomDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId, message_id: envelope.message_id });
    }
  }
  return { invocations, roomDeliveries, routerDeliveries };
}
