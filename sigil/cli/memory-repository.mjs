// In-memory stand-in for the PostgreSQL repository the relay expects
// (see relay/v1/postgres-repository.mjs). Enough of the interface to run
// a real local relay for a demo or single-machine session. State lives
// only in this process -- restarting `sigil relay up` loses history.
import crypto from 'node:crypto';
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';
import { boundedDirectoryExpiry } from '../relay/v1/auth-policy.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { identityKeys } from './identity.mjs';
import { withAfterCommitScope } from '../relay/v1/after-commit.mjs';

const SEEDED_CAPABILITIES = new Map([
  ['sigil.core/read_shared_context', { namespace: 'sigil.core', risk_tier: 'standard' }],
  ['sigil.core/broadcast_message', { namespace: 'sigil.core', risk_tier: 'standard' }],
  ['sigil.task/submit', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.task/read_inbox', { namespace: 'sigil.task', risk_tier: 'low' }],
  ['sigil.task/read_result', { namespace: 'sigil.task', risk_tier: 'low' }],
  ['sigil.task/process', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.task/submit_result', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.approval/request', { namespace: 'sigil.approval', risk_tier: 'high' }],
]);

// Shallow copy of a stored federation_directory_links row shaped exactly like
// the Postgres `rowToFederationDirectoryLink` mapper (same snake_case key set,
// no internal `id` / `created_at` / `updated_at`). The accept-federation-directory
// handlers (Task 8) are one shared code path across both repos; handing back the
// live Map row would let a handler mutation silently corrupt this store while
// Postgres stays intact.
function fdlRowView(row) {
  return {
    link_ref: row.link_ref,
    local_owner_id: row.local_owner_id,
    local_endpoint_id: row.local_endpoint_id,
    remote_owner_id: row.remote_owner_id,
    remote_endpoint_id: row.remote_endpoint_id,
    remote_domain: row.remote_domain,
    role: row.role,
    initiated_via: row.initiated_via,
    status: row.status,
    local_confirmed_at: row.local_confirmed_at,
    remote_confirmed_at: row.remote_confirmed_at,
    source_invite_id: row.source_invite_id,
    peer_domain: row.peer_domain,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    last_reason_code: row.last_reason_code,
  };
}

export function createMemoryRepository({ registry = new Map() } = {}) {
  const envelopes = new Map();
  const deliveries = new Map();
  const idempotency = new Map();
  const grants = [];
  const rateWindows = new Map();
  const acknowledgements = new Map();
  const directoryInvites = new Map(); // code -> invite row (memory repo has no separate hash step -- single process, nothing to hide from itself)
  const directoryLinks = new Map();
  const directoryMatchRequests = new Map();
  const federationDirectoryInvites = new Map(); // link_ref -> invite row (migration 018, cross-federation directory)
  const federationDirectoryLinks = new Map(); // link_ref -> link row (migration 018, cross-federation directory)
  const federationRelayNonces = new Map(); // nonce -> expiresAt ISO (migration 019, replay guard)
  const humanSessions = new Map();
  const consumedLoginJtis = new Map();
  const oidcIssuerAllowlist = new Map();
  const peerRelays = new Map();
  const streamSequences = new Map();
  const relayJobs = new Map();
  const auditEvents = [];
  const approvalDecisions = new Map(); // decision_id -> row (in-memory stand-in for approval_decisions)
  const workspaces = new Map(); // workspace_id -> row (migration 027)
  const rooms = new Map(); // conversation_id -> room row (migration 027)
  const roomMembers = new Map(); // conversation_id -> Map(endpoint_id -> member row incl. removed_at)
  const roomInvocations = new Map(); // invocation_id -> row (migration 028)
  const roomThreads = new Map(); // JSON [room_id, thread_root_id] -> { agent_turns, updated_at } (migration 028)
  // Scoped rollback support for withTransaction (Devin review, PR #6): this
  // repo has no real transaction to roll back, so a mutation performed mid-
  // callback (e.g. consumeApprovalDecision) stayed committed even when the
  // callback later threw and the envelope was ultimately rejected -- a
  // human-approved, one-time decision was silently burned by an unrelated,
  // retriable failure. Approval consumption and the room dispatch writes
  // (envelope, invocations, turns, deliveries) register an undo here; this is
  // not a general transaction log. Undos run newest first, so two writes to
  // one key restore its original value.
  const transactionRollbackStore = new AsyncLocalStorage(); // per-async-context undo stack
  const onRollback = (undo) => { transactionRollbackStore.getStore()?.push(undo); };
  // Registers an undo that puts `key` in `map` back to its current state.
  const undoMapSet = (map, key) => {
    const had = map.has(key);
    const previous = map.get(key);
    const previousCopy = previous && typeof previous === 'object' ? { ...previous } : previous;
    onRollback(() => {
      if (!had) { map.delete(key); return; }
      if (previous && typeof previous === 'object') Object.assign(previous, previousCopy);
      map.set(key, previous);
    });
  };
  return {
    // Single-process, no real client/connection -- the transaction wrapper
    // exists so acceptEnvelopeAsync's repository-aware path works unchanged
    // against this repository too (design §12 dual-repository equivalence).
    async withTransaction(fn) {
      return withAfterCommitScope(async () => {
        const parent = transactionRollbackStore.getStore() ?? null;
        const rollbacks = [];
        return transactionRollbackStore.run(rollbacks, async () => {
          try {
            const result = await fn(null);
            // Nested success: merge child undos into parent so a later parent
            // throw still reverses the nested mutations.
            if (parent) {
              for (const undo of rollbacks) parent.push(undo);
            }
            return result;
          } catch (error) {
            for (const undo of rollbacks.reverse()) undo();
            throw error;
          }
        });
      });
    },
    async assignStreamSequence(_client, senderEndpointId, conversationId) {
      const key = JSON.stringify([senderEndpointId, conversationId]);
      const assigned = streamSequences.get(key) ?? 1n;
      streamSequences.set(key, assigned + 1n);
      return assigned;
    },
    async lookupStreamHighWater(senderEndpointId, conversationId) {
      const next = streamSequences.get(JSON.stringify([senderEndpointId, conversationId]));
      return next == null ? 0n : next - 1n;
    },
    async listResendEnvelopes(senderEndpointId, conversationId, beginSeq, endSeq, now = new Date()) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      return [...envelopes.values()]
        .filter((row) => row.envelope.sender.endpoint_id === senderEndpointId
          && row.envelope.conversation_id === conversationId
          && row.streamSeq != null
          && row.streamSeq >= BigInt(beginSeq)
          && row.streamSeq <= BigInt(endSeq)
          && Date.parse(row.envelope.expires_at) > timestamp)
        .sort((a, b) => (a.streamSeq < b.streamSeq ? -1 : a.streamSeq > b.streamSeq ? 1 : 0))
        .map((row) => ({ streamSeq: row.streamSeq, envelope: row.envelope }));
    },
    async isConversationMember(endpointId, conversationId) {
      return [...envelopes.values()].some((row) => row.envelope.conversation_id === conversationId
        && (row.envelope.sender.endpoint_id === endpointId || row.envelope.recipient?.endpoint_id === endpointId));
    },
    async enqueueRelayJob(jobType, row) {
      const existing = [...relayJobs.values()].find((job) => job.jobType === jobType && job.idempotencyKey === row.idempotencyKey);
      if (existing) return { row: existing, inserted: false };
      const timestamp = (row.now instanceof Date ? row.now : row.now ? new Date(row.now) : new Date()).toISOString();
      const job = {
        id: `job_${crypto.randomUUID()}`, jobType, idempotencyKey: row.idempotencyKey,
        payload: row.payload ?? null, state: 'pending', attemptCount: 0, nextAttemptAt: timestamp,
        claimedAt: null, claimToken: null, lastReasonCode: null, createdAt: timestamp, updatedAt: timestamp,
      };
      relayJobs.set(job.id, job);
      return { row: job, inserted: true };
    },
    async claimDueRelayJobs(jobType, now = new Date(), limit = 10, leaseSeconds = 30) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      return [...relayJobs.values()]
        .filter((job) => job.jobType === jobType
          && ((job.state === 'pending' && Date.parse(job.nextAttemptAt) <= timestamp)
            || (job.state === 'processing' && Date.parse(job.claimedAt) < timestamp - leaseSeconds * 1000)))
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
        .slice(0, limit)
        .map((job) => {
          job.state = 'processing';
          job.claimedAt = new Date(timestamp).toISOString();
          job.claimToken = crypto.randomUUID();
          job.updatedAt = job.claimedAt;
          return { ...job };
        });
    },
    async relayJobHealth(jobType = 'resend', now = new Date()) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      const active = [...relayJobs.values()].filter((job) => job.jobType === jobType && ['pending', 'processing'].includes(job.state));
      const oldest = active.length ? Math.min(...active.map((job) => Date.parse(job.createdAt))) : timestamp;
      return { depth: active.length, oldestAgeSeconds: Math.max(0, (timestamp - oldest) / 1000) };
    },
    async finalizeRelayJob(jobType, id, claimToken, state, { attemptCount = null, nextAttemptAt = null, reasonCode = null } = {}) {
      const job = relayJobs.get(id);
      if (!job || job.jobType !== jobType || job.claimToken !== claimToken) return { updated: false };
      job.state = state;
      job.claimToken = null;
      job.claimedAt = null;
      if (attemptCount != null) job.attemptCount = attemptCount;
      if (nextAttemptAt != null) job.nextAttemptAt = (nextAttemptAt instanceof Date ? nextAttemptAt : new Date(nextAttemptAt)).toISOString();
      job.lastReasonCode = reasonCode;
      job.updatedAt = new Date().toISOString();
      return { updated: true };
    },
    async reserveRateLimit(scopeKind, scopeId, windowStart, limit) {
      const key = `${scopeKind}:${scopeId}:${windowStart}`;
      const count = (rateWindows.get(key) ?? 0) + 1;
      rateWindows.set(key, count);
      return { count, allowed: count <= limit };
    },
    async countOpenDeliveries(recipientEndpointId) {
      const terminal = new Set(['acknowledged', 'processed', 'delivery_rejected', 'dead_letter']);
      return [...deliveries.values()].filter((d) => d.recipient_endpoint_id === recipientEndpointId && !terminal.has(d.state)).length;
    },
    async lookupIdempotency(endpointId, idempotencyKey) {
      return idempotency.get(`${endpointId}:${idempotencyKey}`) ?? null;
    },
    async lookupTaskRequest(taskId, conversationId) {
      for (const row of envelopes.values()) {
        if (row.envelope.conversation_id === conversationId && row.envelope.message_type === 'task.request' && row.envelope.body?.task_id === taskId) {
          return { message_id: row.envelope.message_id, recipientEndpointId: row.envelope.recipient?.endpoint_id ?? null };
        }
      }
      return null;
    },
    async lookupAcceptedMessageId(senderEndpointId, messageId) {
      for (const row of envelopes.values()) {
        if (row.envelope.sender.endpoint_id === senderEndpointId && row.envelope.message_id === messageId) {
          return { message_id: row.envelope.message_id, idempotency_key: row.envelope.idempotency_key };
        }
      }
      return null;
    },
    async lookupRecipientEndpoint(endpointId) {
      const endpoint = registry.get(endpointId);
      return endpoint?.status === 'active' ? endpoint : null;
    },
    async ensureRoomSystemEndpoint({ identity }) {
      const publicKey = identityKeys(identity).publicKey;
      const existing = registry.get(identity.endpoint_id);
      if (existing?.status === 'active') {
        if (existing.owner_id !== identity.owner_id) {
          throw Object.assign(new Error(`endpoint "${identity.endpoint_id}" is already registered to a different owner`), { code: 'ROOM_SYSTEM_OWNER_MISMATCH' });
        }
        const same = existing.key_id === identity.key_id
          && existing.public_key?.export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }));
        if (same) return;
        throw Object.assign(new Error(`endpoint "${identity.endpoint_id}" is already registered with a different key`), { code: 'ROOM_SYSTEM_KEY_MISMATCH' });
      }
      registry.set(identity.endpoint_id, {
        endpoint_id: identity.endpoint_id, owner_id: identity.owner_id, key_id: identity.key_id, status: 'active', kind: 'system',
        public_key: publicKey,
      });
    },
    // Federated-inbound shadow registration (design R10). A foreign sender
    // (endpoint homed on another relay) is not in this relay's registry, so
    // an accepted federated envelope would have nothing to hang its FK chain
    // on in the Postgres path. Insert a minimal active registry entry keyed
    // by endpoint_id, mirroring the shape other entries use; origin_domain
    // marks it as a shadow row. No-op if the endpoint is already present.
    async registerFederatedSender({ endpoint_id, owner_id, key_id, public_key, origin_domain }) {
      if (registry.has(endpoint_id)) return;
      registry.set(endpoint_id, { endpoint_id, owner_id, key_id, status: 'active', public_key, origin_domain });
    },
    async persistAcceptedEnvelope(row) {
      const idempotencyKey = `${row.envelope.sender.endpoint_id}:${row.envelope.idempotency_key}`;
      const priorKey = idempotency.get(idempotencyKey);
      if (priorKey && priorKey.message_id !== row.message_id) {
        throw Object.assign(new Error('idempotency key already used by another message'), { code: 'IDEMPOTENCY_RACE' });
      }
      const federationHop = row.federation_hop === true;
      undoMapSet(envelopes, row.message_id);
      undoMapSet(idempotency, idempotencyKey);
      envelopes.set(row.message_id, { ...row, streamSeq: row.streamSeq ?? null, roomSeq: row.roomSeq ?? null, federation_hop: federationHop });
      idempotency.set(idempotencyKey, { message_id: row.message_id, canonical_hash: row.canonical_hash });
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        undoMapSet(deliveries, deliveryId);
        deliveries.set(deliveryId, {
          delivery_id: deliveryId,
          message_id: row.message_id,
          recipient_endpoint_id: row.envelope.recipient.endpoint_id,
          state: 'delivered',
          queued_at: new Date().toISOString(),
          attempts: 0,
          federation_hop: federationHop
        });
      }
      if (Array.isArray(row.roomFanout)) {
        const fanout = row.roomFanout.map((endpointId) => {
          const deliveryId = `del_${row.message_id}_${endpointId}`;
          undoMapSet(deliveries, deliveryId);
          deliveries.set(deliveryId, { delivery_id: deliveryId, message_id: row.message_id, recipient_endpoint_id: endpointId, state: 'delivered', queued_at: new Date().toISOString(), attempts: 0, federation_hop: false });
          return { endpoint_id: endpointId, delivery_id: deliveryId };
        });
        return { message_id: row.message_id, duplicate: false, fanout };
      }
      return { message_id: row.message_id, duplicate: false };
    },
    async createRoom({ conversationId, workspaceId, name, description = null, createdByHumanId, ownerEndpointId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      if ([...rooms.values()].some((room) => room.workspace_id === workspaceId && room.name === name)) {
        throw Object.assign(new Error('A room with this name already exists in the workspace'), { code: 'ROOM_NAME_TAKEN' });
      }
      if (!workspaces.has(workspaceId)) workspaces.set(workspaceId, { workspace_id: workspaceId, name: workspaceId, created_by: createdByHumanId, created_at: timestamp });
      const room = { conversation_id: conversationId, workspace_id: workspaceId, name, description, created_at: timestamp, max_agent_turns: 6 };
      rooms.set(conversationId, { ...room, next_room_seq: 1n, archived_at: null });
      roomMembers.set(conversationId, new Map([[ownerEndpointId, { endpoint_id: ownerEndpointId, role: 'owner', response_mode: null, added_by: createdByHumanId, added_at: timestamp, removed_at: null }]]));
      return room;
    },
    async lookupRoom(conversationId) {
      const room = rooms.get(conversationId);
      if (!room) return null;
      const { next_room_seq: _seq, archived_at: _archived, ...visible } = room;
      return visible;
    },
    async listRoomsForEndpoint(endpointId) {
      return [...rooms.keys()]
        .filter((conversationId) => roomMembers.get(conversationId)?.get(endpointId)?.removed_at === null)
        .map((conversationId) => { const { next_room_seq: _seq, archived_at: _archived, ...visible } = rooms.get(conversationId); return visible; });
    },
    async addRoomMember({ conversationId, endpointId, role, responseMode = null, addedByHumanId, now = new Date() }) {
      const members = roomMembers.get(conversationId);
      if (!members) throw Object.assign(new Error('Room not found'), { code: 'ROOM_NOT_FOUND' });
      if (members.get(endpointId)?.removed_at === null) throw Object.assign(new Error('Endpoint is already a room member'), { code: 'ROOM_MEMBER_EXISTS' });
      const member = { endpoint_id: endpointId, role, response_mode: responseMode, added_by: addedByHumanId, added_at: (now instanceof Date ? now : new Date(now)).toISOString(), removed_at: null };
      members.set(endpointId, member);
      return { endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at };
    },
    async removeRoomMember({ conversationId, endpointId, now = new Date() }) {
      const member = roomMembers.get(conversationId)?.get(endpointId);
      if (!member || member.removed_at !== null) return false;
      member.removed_at = (now instanceof Date ? now : new Date(now)).toISOString();
      return true;
    },
    async lookupRoomMember(conversationId, endpointId) {
      const member = roomMembers.get(conversationId)?.get(endpointId);
      if (!member || member.removed_at !== null) return null;
      return { endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at };
    },
    async listRoomMembers(conversationId) {
      return [...(roomMembers.get(conversationId)?.values() ?? [])]
        .filter((member) => member.removed_at === null)
        .sort((a, b) => a.added_at.localeCompare(b.added_at))
        .map((member) => ({ endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at }));
    },
    // Not undone by withTransaction: a rejected accept can leave a gap in the
    // memory repo's room_seq. Postgres assigns inside the accept transaction,
    // so its sequence stays gapless.
    async assignRoomSequence(_client, conversationId) {
      const room = rooms.get(conversationId);
      const assigned = room.next_room_seq;
      room.next_room_seq = assigned + 1n;
      return assigned;
    },
    async listRoomMessages(conversationId, afterSeq = 0n, limit = 100) {
      return [...envelopes.values()]
        .filter((row) => row.envelope.conversation_id === conversationId && row.roomSeq != null && row.roomSeq > BigInt(afterSeq))
        .sort((a, b) => (a.roomSeq < b.roomSeq ? -1 : a.roomSeq > b.roomSeq ? 1 : 0))
        .slice(0, limit)
        .map((row) => ({ room_seq: String(row.roomSeq), message_id: row.message_id, canonical_bytes: row.canonical_bytes == null ? null : Buffer.from(row.canonical_bytes).toString('base64url'), envelope: row.envelope }));
    },
    // Serialization is a Postgres concern; the memory repo has no concurrent transactions.
    async lockRoom() {},
    async lookupRoomEventByKey(conversationId, idempotencyKey) {
      const row = [...envelopes.values()].find((r) => r.envelope.conversation_id === conversationId && r.envelope.message_type === 'room.event' && r.envelope.idempotency_key === idempotencyKey);
      return row ? { message_id: row.message_id } : null;
    },
    async lookupRouterDecision(triggerMessageId) {
      return [...roomInvocations.values()].filter((r) => r.trigger_message_id === triggerMessageId && r.decided_by === 'router').map((r) => ({ ...r }));
    },
    async lookupRoomMessage(conversationId, messageId) {
      const row = envelopes.get(messageId);
      if (!row || row.envelope.conversation_id !== conversationId) return null;
      return { room_seq: row.roomSeq == null ? null : String(row.roomSeq), message_id: row.message_id, envelope: row.envelope };
    },
    async createRoomInvocation({ invocationId, roomId, workspaceId: _workspaceId, triggerMessageId, threadRootId, endpointId, decidedBy, reason = null, status, deliveryId = null, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const rows = [...roomInvocations.values()];
      if (rows.some((row) => row.trigger_message_id === triggerMessageId && row.endpoint_id === endpointId)) {
        throw Object.assign(new Error('This message already invoked this agent'), { code: 'ROOM_INVOCATION_EXISTS' });
      }
      if (status === 'running' && rows.some((row) => row.room_id === roomId && row.endpoint_id === endpointId && row.status === 'running')) {
        throw Object.assign(new Error('The agent already has a running invocation in this room'), { code: 'ROOM_INVOCATION_RUNNING' });
      }
      const row = {
        invocation_id: invocationId, room_id: roomId, trigger_message_id: triggerMessageId, thread_root_id: threadRootId, endpoint_id: endpointId,
        decided_by: decidedBy, reason, status, delivery_id: deliveryId, reply_message_id: null, created_at: timestamp,
        started_at: status === 'running' ? timestamp : null, finished_at: status === 'refused' ? timestamp : null,
      };
      undoMapSet(roomInvocations, invocationId);
      roomInvocations.set(invocationId, row);
      return { ...row };
    },
    async lookupRunningInvocation(roomId, endpointId) {
      const row = [...roomInvocations.values()].find((r) => r.room_id === roomId && r.endpoint_id === endpointId && r.status === 'running');
      return row ? { ...row } : null;
    },
    async nextQueuedInvocation(roomId, endpointId) {
      const row = [...roomInvocations.values()]
        .filter((r) => r.room_id === roomId && r.endpoint_id === endpointId && r.status === 'queued')
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.invocation_id.localeCompare(b.invocation_id))[0];
      return row ? { ...row } : null;
    },
    async startInvocation(invocationId, { deliveryId, now = new Date() }) {
      const row = roomInvocations.get(invocationId);
      if (!row || row.status !== 'queued') return null;
      undoMapSet(roomInvocations, invocationId);
      Object.assign(row, { status: 'running', delivery_id: deliveryId, started_at: (now instanceof Date ? now : new Date(now)).toISOString() });
      return { ...row };
    },
    async finishInvocation(invocationId, { status, reason = null, replyMessageId = null, now = new Date() }) {
      const row = roomInvocations.get(invocationId);
      if (!row || (row.status !== 'queued' && row.status !== 'running')) return null;
      undoMapSet(roomInvocations, invocationId);
      Object.assign(row, { status, reason: reason ?? row.reason, reply_message_id: replyMessageId, finished_at: (now instanceof Date ? now : new Date(now)).toISOString() });
      return { ...row };
    },
    async cancelRoomInvocations(roomId, { now = new Date() } = {}) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const cancelled = [];
      for (const row of roomInvocations.values()) {
        if (row.room_id !== roomId || (row.status !== 'queued' && row.status !== 'running')) continue;
        undoMapSet(roomInvocations, row.invocation_id);
        Object.assign(row, { status: 'cancelled', reason: 'stopped', finished_at: timestamp });
        cancelled.push({ ...row });
      }
      return cancelled;
    },
    async listRoomInvocations(roomId, { endpointId = null, status = null, limit = 100 } = {}) {
      return [...roomInvocations.values()]
        .filter((r) => r.room_id === roomId && (!endpointId || r.endpoint_id === endpointId) && (!status || r.status === status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.invocation_id.localeCompare(a.invocation_id))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async reserveAgentTurn(roomId, threadRootId, maxTurns, { now = new Date() } = {}) {
      const key = JSON.stringify([roomId, threadRootId]);
      const current = roomThreads.get(key)?.agent_turns ?? 0;
      if (current >= maxTurns) return { allowed: false, agent_turns: current };
      undoMapSet(roomThreads, key);
      roomThreads.set(key, { agent_turns: current + 1, updated_at: (now instanceof Date ? now : new Date(now)).toISOString() });
      return { allowed: true, agent_turns: current + 1 };
    },
    async resetAgentTurns(roomId, threadRootId, { now = new Date() } = {}) {
      undoMapSet(roomThreads, JSON.stringify([roomId, threadRootId]));
      roomThreads.set(JSON.stringify([roomId, threadRootId]), { agent_turns: 0, updated_at: (now instanceof Date ? now : new Date(now)).toISOString() });
    },
    async createRoomDelivery({ messageId, endpointId, now = new Date() }) {
      const deliveryId = `del_${messageId}_${endpointId}`;
      undoMapSet(deliveries, deliveryId);
      deliveries.set(deliveryId, { delivery_id: deliveryId, message_id: messageId, recipient_endpoint_id: endpointId, state: 'delivered', queued_at: (now instanceof Date ? now : new Date(now)).toISOString(), attempts: 0, federation_hop: false });
      return deliveryId;
    },
    async listInbox(endpointId, since = '', viewerOwnerId = null) {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.state === 'delivered' && d.queued_at > since)
        .map((d) => { const row = envelopes.get(d.message_id); const envelope = row.envelope; return { delivery_id: d.delivery_id, message_id: d.message_id, envelope, queued_at: d.queued_at, streamSeq: row.streamSeq == null ? null : String(row.streamSeq), sender_unverified: !viewerOwnerId || !acknowledgements.has(`${viewerOwnerId}:${envelope.sender.endpoint_id}`) }; });
    },
    async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId, now = new Date() }) {
      const record = { viewer_owner_id: viewerOwnerId, acknowledged_endpoint_id: acknowledgedEndpointId, acknowledged_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      acknowledgements.set(`${viewerOwnerId}:${acknowledgedEndpointId}`, record);
      return record;
    },
    async createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now = new Date() }) {
      const inviteId = `invite_${crypto.randomUUID()}`;
      const code = crypto.randomBytes(24).toString('base64url');
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const expiry = boundedDirectoryExpiry({ now, expiresAt });
      directoryInvites.set(code, { invite_id: inviteId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, status: 'pending', expires_at: expiry.toISOString(), home_relay: homeRelay, created_at: timestamp });
      return { invite_id: inviteId, code, expires_at: expiry.toISOString() };
    },
    async redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const invite = directoryInvites.get(code);
      if (!invite || invite.status !== 'pending' || invite.expires_at <= timestamp) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      // Mirrors postgres-repository.mjs's human_a <> human_b guard (backed
      // there by directory_links' CHECK constraint): a human can't link to
      // their own other endpoint via their own invite. Checked before the
      // invite is marked redeemed, same as the Postgres path.
      if (invite.issuer_human_id === redeemerHumanId) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      invite.status = 'redeemed'; invite.redeemed_by_human_id = redeemerHumanId; invite.redeemed_at = timestamp;
      const [endpointA, endpointB] = [invite.issuer_endpoint_id, redeemerEndpointId].sort();
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === invite.issuer_endpoint_id ? [invite.issuer_human_id, redeemerHumanId] : [redeemerHumanId, invite.issuer_human_id];
      const link = {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'invite',
        a_confirmed_at: endpointA === invite.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === invite.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === invite.issuer_endpoint_id ? null : redeemerHumanId,
        b_confirmed_by: endpointA === invite.issuer_endpoint_id ? redeemerHumanId : null,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      };
      directoryLinks.set(linkId, link);
      return { link_id: linkId, status: 'pending' };
    },
    async createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now = new Date() }) {
      const requestId = `dreq_${crypto.randomUUID()}`;
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      // Mirrors createDirectoryInvite's use of boundedDirectoryExpiry (same
      // [1h, 7d] bound and Date-coercion) instead of calling
      // expiresAt.toISOString() directly, which would throw on an
      // undefined/string expiresAt.
      const expiry = boundedDirectoryExpiry({ now, expiresAt });
      directoryMatchRequests.set(requestId, { request_id: requestId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, issuer, match_target: matchTarget, status: 'pending', expires_at: expiry.toISOString(), home_relay: homeRelay, created_at: timestamp });
      return { request_id: requestId };
    },
    // Single-process, no real client/connection -- "concurrency" here
    // reduces to first-write-wins on a synchronous find + mutation, with no
    // `await` between the find and the status flip so nothing else in this
    // single-threaded event loop can interleave and see the same pending
    // row: equivalent in effect to Postgres's SELECT ... FOR UPDATE SKIP
    // LOCKED for a store with only one writer ever active at a time.
    async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const candidate = [...directoryMatchRequests.values()].find((r) => r.issuer === issuer && r.match_target === matchTarget && r.status === 'pending' && r.expires_at > timestamp);
      if (!candidate) return null;
      candidate.status = 'matched'; candidate.matched_human_id = matchedHumanId; candidate.matched_at = timestamp;
      return { request_id: candidate.request_id };
    },
    async nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const request = directoryMatchRequests.get(requestId);
      if (!request || request.status !== 'matched' || request.matched_human_id !== nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      // Mirrors redeemDirectoryInvite's human_a <> human_b guard (backed on
      // the Postgres side by directory_links' CHECK constraint): a human
      // can't link to their own other endpoint via their own match. Checked
      // before the request is marked consumed, same as the Postgres path.
      if (request.issuer_human_id === nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      request.status = 'consumed'; request.consumed_at = timestamp;
      const [endpointA, endpointB] = [request.issuer_endpoint_id, nominatedEndpointId].sort();
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === request.issuer_endpoint_id ? [request.issuer_human_id, nominatedHumanId] : [nominatedHumanId, request.issuer_human_id];
      directoryLinks.set(linkId, {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'oidc_match',
        a_confirmed_at: endpointA === request.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === request.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === request.issuer_endpoint_id ? null : nominatedHumanId,
        b_confirmed_by: endpointA === request.issuer_endpoint_id ? nominatedHumanId : null,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      });
      return { link_id: linkId, status: 'pending' };
    },
    async confirmDirectoryLink({ linkId, confirmingHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status !== 'pending') return { link_id: linkId, status: link.status };
      if (confirmingHumanId !== link.human_a && confirmingHumanId !== link.human_b) {
        throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const isA = confirmingHumanId === link.human_a;
      if (isA && link.a_confirmed_at) return { link_id: linkId, status: link.status };
      if (!isA && link.b_confirmed_at) return { link_id: linkId, status: link.status };
      if (isA) { link.a_confirmed_at = timestamp; link.a_confirmed_by = confirmingHumanId; } else { link.b_confirmed_at = timestamp; link.b_confirmed_by = confirmingHumanId; }
      link.status = (link.a_confirmed_at && link.b_confirmed_at) ? 'active' : 'pending';
      return { link_id: linkId, status: link.status };
    },
    async revokeDirectoryLink({ linkId, revokingHumanId, now = new Date() }) {
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'revoked') return { link_id: linkId, status: 'revoked', duplicate: true };
      if (revokingHumanId !== link.human_a && revokingHumanId !== link.human_b) {
        throw Object.assign(new Error('Revoking human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      link.status = 'revoked'; link.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString(); link.revoked_by = revokingHumanId;
      return { link_id: linkId, status: 'revoked', duplicate: false };
    },
    async lookupActiveDirectoryLink(endpointIdA, endpointIdB) {
      const found = [...directoryLinks.values()].find((l) => l.status === 'active' && ((l.endpoint_a === endpointIdA && l.endpoint_b === endpointIdB) || (l.endpoint_a === endpointIdB && l.endpoint_b === endpointIdA)));
      return found ? { link_id: found.link_id, status: found.status } : null;
    },
    // Test-only: exposes the raw stored record (including a_confirmed_by/
    // b_confirmed_by, which no production-facing method returns) so
    // regression tests can assert on confirmation attribution directly.
    _debugGetDirectoryLink(linkId) {
      return directoryLinks.get(linkId);
    },
    async acknowledgeDelivery({ deliveryId, endpointId, now }) {
      const current = deliveries.get(deliveryId);
      if (!current || current.recipient_endpoint_id !== endpointId) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      if (current.state === 'acknowledged') return { ...current, duplicate: true };
      const next = transitionDelivery(current, 'acknowledged', { now });
      deliveries.set(deliveryId, next);
      return next;
    },
    async getDelivery(deliveryId, endpointId) {
      const current = deliveries.get(deliveryId);
      return current && current.recipient_endpoint_id === endpointId ? current : null;
    },
    async transitionDelivery(deliveryId, _endpointId, _target, { next }) {
      deliveries.set(deliveryId, next);
      return next;
    },
    async lookupCapabilityRegistration(capability) {
      const entry = SEEDED_CAPABILITIES.get(capability);
      return entry ? { capability, namespace: entry.namespace, risk_tier: entry.risk_tier } : null;
    },
    async lookupMessageSender(messageId) {
      const row = envelopes.get(messageId);
      return row ? { endpoint_id: row.envelope.sender.endpoint_id } : null;
    },
    // What a freshly inserted delivery's state is. The accept-time receipt
    // frame reads it so the sender sees the row's real state. This store
    // inserts `delivered` directly and its `listInbox` has no queued-to-delivered flip.
    initialDeliveryState: 'delivered',
    async listReceiptsForMessage(messageId) {
      return [...deliveries.values()]
        .filter((d) => d.message_id === messageId)
        .sort((a, b) => {
          if (a.queued_at !== b.queued_at) return a.queued_at < b.queued_at ? -1 : 1;
          if (a.recipient_endpoint_id === b.recipient_endpoint_id) return 0;
          return a.recipient_endpoint_id < b.recipient_endpoint_id ? -1 : 1;
        })
        .map((d) => ({ ...d }));
    },
    async lookupEnvelopeStreamSequence(messageId) {
      return envelopes.get(messageId)?.streamSeq ?? null;
    },
    // No real row locking possible/needed in a single-process in-memory
    // store -- withTransaction is already a no-op here (see above).
    async lookupActiveCapabilityGrants(endpointId, now) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      return grants.filter((g) => g.granted_to === endpointId && !g.revoked_at && new Date(g.expires_at).getTime() > timestamp).map((g) => ({ capability: g.capability, scope: g.scope }));
    },
    async createCapabilityGrant({ grantId, capability, scope, grantedTo, expiresAt, now = new Date() }) {
      const grant = { grant_id: grantId, capability, scope, granted_to: grantedTo, expires_at: expiresAt, revoked_at: null, granted_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      grants.push(grant);
      return grant;
    },
    async revokeCapabilityGrant(grantId, { now = new Date() } = {}) {
      const grant = grants.find((g) => g.grant_id === grantId);
      if (!grant) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
      if (grant.revoked_at) return { ...grant, duplicate: true };
      grant.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString();
      return { ...grant, duplicate: false };
    },
    // Test/demo seeding for the approval_decisions ceremony this repo has no
    // real WebAuthn flow for -- shaped like postgres-repository.mjs's
    // finalizeApprovalDecision output, minus the challenge/credential
    // plumbing a real ceremony would have already verified.
    async recordApprovalDecision({ decisionId = `decision_${crypto.randomUUID()}`, endpointId, actionHash, expiresAt, validUntil = null, credentialValidUntil = null, now = new Date() }) {
      const decision = {
        decision_id: decisionId,
        endpoint_id: endpointId,
        action_hash: actionHash,
        status: 'approved',
        created_at: (now instanceof Date ? now : new Date(now)).toISOString(),
        expires_at: expiresAt,
        // Optional credential window (mirrors human_credentials.valid_until).
        valid_until: validUntil,
        credential_valid_until: credentialValidUntil ?? validUntil,
      };
      approvalDecisions.set(decisionId, decision);
      return decision;
    },
    // Mirrors postgres-repository.mjs's consumeApprovalDecision: atomically
    // (single-process, so trivially so) claims and marks 'consumed' the
    // first matching 'approved', unexpired decision -- see accept-envelope.mjs's
    // high-risk capability gate. Returns null on no match, same fail-closed
    // contract as the Postgres version. `.find()` already claims at most one
    // row even when duplicates exist (Devin review, PR #6). This repo has no
    // humans/human_credentials of its own to check revocation against --
    // Postgres is the real security boundary for that; a demo/test decision
    // seeded here is trusted for the life of the process.
    async consumeApprovalDecision({ endpointId, actionHash, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      const prefixedHash = `sha256:${actionHash}`;
      const decision = [...approvalDecisions.values()].find((d) => {
        if (d.endpoint_id !== endpointId) return false;
        if (!(d.action_hash === actionHash || d.action_hash === prefixedHash)) return false;
        if (d.status !== 'approved') return false;
        if (!(new Date(d.expires_at).getTime() > timestamp)) return false;
        // Mirror postgres: expired credentials (valid_until) cannot consume
        // even when status is still 'active'/approved.
        const validUntil = d.credential_valid_until ?? d.valid_until ?? null;
        if (validUntil != null && !(new Date(validUntil).getTime() > timestamp)) return false;
        return true;
      });
      if (!decision) return null;
      decision.status = 'consumed';
      onRollback(() => { decision.status = 'approved'; });
      return decision;
    },
    async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date() }) {
      const issued = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
      const expires = (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString();
      const session = { session_id: sessionId, human_id: humanId, authentication_method: authenticationMethod, assurance, device_context: deviceContext, issued_at: issued, version: 1, expires_at: expires, revoked_at: null };
      humanSessions.set(sessionId, session);
      return session;
    },
    async consumeLoginJti(jti, { now = new Date(), expiresAt }) {
      if (consumedLoginJtis.has(jti)) {
        throw Object.assign(new Error('ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      }
      consumedLoginJtis.set(jti, (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString());
      return undefined;
    },
    async getOidcIssuerAllowlistEntry(issuer) {
      const entry = oidcIssuerAllowlist.get(issuer);
      return entry ? { issuer, clientId: entry.clientId ?? null, enabled: entry.enabled } : null;
    },
    async listOidcIssuerAllowlist({ includeDisabled = false } = {}) {
      return [...oidcIssuerAllowlist.entries()]
        .filter(([, entry]) => includeDisabled || entry.enabled)
        .map(([issuer, entry]) => ({ issuer, clientId: entry.clientId ?? null, enabled: entry.enabled, assuranceLevel: entry.assuranceLevel ?? 'standard' }));
    },
    async upsertOidcIssuerAllowlist({ issuer, clientId = null, assuranceLevel = 'standard', enabled = true } = {}) {
      oidcIssuerAllowlist.set(issuer, { clientId, enabled, assuranceLevel });
    },
    // Soft-disable, mirroring postgres-repository.mjs's UPDATE ... SET
    // enabled = FALSE -- re-adding goes back through upsertOidcIssuerAllowlist.
    async disableOidcIssuerAllowlist(issuer) {
      const entry = oidcIssuerAllowlist.get(issuer);
      if (entry) entry.enabled = false;
    },
    async upsertPeer({ domain, relayUrl, wsUrl = null, keys, trustMode, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const existing = peerRelays.get(domain);
      const record = {
        domain, relayUrl, wsUrl, keys, trustMode,
        discoveredAt: existing?.discoveredAt ?? timestamp,
        updatedAt: timestamp,
        lastResolvedAt: timestamp,
      };
      peerRelays.set(domain, record);
      return record;
    },
    async getPeerByDomain(domain) {
      return peerRelays.get(domain) ?? null;
    },
    async getPeerByKid(kid) {
      for (const peer of peerRelays.values()) {
        if ((peer.keys ?? []).some((k) => k.kid === kid)) return peer;
      }
      return null;
    },
    async listPeers() {
      return [...peerRelays.values()].sort((a, b) => a.domain.localeCompare(b.domain));
    },
    async removePeer(domain) {
      return peerRelays.delete(domain);
    },
    // Test-only: memory-repository has no admin/migration path, so tests
    // that exercise the real-login route seed allow-list rows directly,
    // mirroring how Postgres tests INSERT into oidc_issuer_allowlist.
    _debugSeedOidcIssuer({ issuer, clientId = null, enabled = true, assuranceLevel = 'standard' }) {
      oidcIssuerAllowlist.set(issuer, { clientId, enabled, assuranceLevel });
    },
    // Mirrors postgres-repository.mjs's recordAuditEvent row shape (minus
    // the actual persistence -- single process, nothing to query it back
    // out of besides this array).
    async recordAuditEvent({ eventId = `audit_${crypto.randomUUID()}`, eventType, subjectId, actorId = null, actorHumanId = null, endpointId = null, conversationId = null, objectType = null, objectId = null, actionHash = null, outcome = null, reason = null, payload = {}, metadataRedacted = null, now = new Date() } = {}) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const event = { event_id: eventId, event_type: eventType, subject_id: subjectId, actor_id: actorId, actor_human_id: actorHumanId, endpoint_id: endpointId, conversation_id: conversationId, object_type: objectType, object_id: objectId, action_hash: actionHash, outcome, reason, payload, metadata_redacted: metadataRedacted, created_at: timestamp };
      auditEvents.push(event);
      return event;
    },
    // Test-only: exposes recorded audit events (mirrors _debugGetDirectoryLink
    // above) so regression tests can assert an event was recorded without a
    // real audit_events table to query.
    _debugGetAuditEvents() {
      return auditEvents;
    },
    // --- federation_directory_invites (migration 018) parity ---------------
    // Local half of the cross-federation directory: a `sync`-only relay can
    // create / look up / revoke / list invites here even though the
    // outbox-drained posts stay on the Postgres repo. `client` is ignored
    // (withTransaction is fn(null)).
    async createFederationDirectoryInvite(row) {
      const inviteId = `fdinv_${crypto.randomUUID()}`;
      const iso = (v) => (v == null ? new Date() : (v instanceof Date ? v : new Date(v))).toISOString();
      federationDirectoryInvites.set(row.linkRef, {
        invite_id: inviteId,
        link_ref: row.linkRef,
        issuer_endpoint_id: row.issuerEndpointId,
        issuer_owner_id: row.issuerOwnerId,
        peer_domain: row.peerDomain,
        code_hash: row.codeHash,
        status: 'pending',
        redeemed_by_owner_id: null,
        redeemed_by_endpoint_id: null,
        redeemed_at: null,
        expires_at: iso(row.expiresAt),
        created_at: iso(row.now),
      });
      return { invite_id: inviteId, link_ref: row.linkRef };
    },
    // Lazy `pending` -> `expired` transition happens in-place with no `await`
    // between the read and the flip -- single writer, mirrors the
    // claimDirectoryMatch concurrency note above.
    async getFederationDirectoryInviteByRef(linkRef) {
      const row = federationDirectoryInvites.get(linkRef);
      if (!row) return null;
      if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
        row.status = 'expired';
      }
      // Return a shallow copy shaped like the Postgres rowToFederationDirectoryInvite
      // mapper (no `created_at`) -- callers such as Task 8's acceptDirectoryRedemption
      // are one shared code path; handing back the live Map row would let a mutation
      // there corrupt the store silently while Postgres is unaffected.
      return {
        invite_id: row.invite_id,
        link_ref: row.link_ref,
        issuer_endpoint_id: row.issuer_endpoint_id,
        issuer_owner_id: row.issuer_owner_id,
        peer_domain: row.peer_domain,
        code_hash: row.code_hash,
        status: row.status,
        redeemed_by_owner_id: row.redeemed_by_owner_id,
        redeemed_by_endpoint_id: row.redeemed_by_endpoint_id,
        redeemed_at: row.redeemed_at,
        expires_at: row.expires_at,
      };
    },
    async markFederationDirectoryInviteRedeemed(inviteId, redeemer, now = new Date()) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      for (const row of federationDirectoryInvites.values()) {
        if (row.invite_id === inviteId) {
          // Defence-in-depth: only a still-`pending` invite can be redeemed
          // (mirrors the Postgres `AND status = 'pending'` WHERE guard).
          if (row.status !== 'pending') return { updated: 0 };
          row.status = 'redeemed';
          row.redeemed_by_owner_id = redeemer.owner_id;
          row.redeemed_by_endpoint_id = redeemer.endpoint_id;
          row.redeemed_at = timestamp;
          return { updated: 1 };
        }
      }
      return { updated: 0 };
    },
    async revokeFederationDirectoryInvite(linkRef) {
      const row = federationDirectoryInvites.get(linkRef);
      if (!row || row.status !== 'pending') return { updated: 0 };
      row.status = 'revoked';
      return { updated: 1 };
    },
    async listFederationDirectoryInvites(filter = {}) {
      return [...federationDirectoryInvites.values()]
        .filter((r) => (filter.issuerOwnerId == null || r.issuer_owner_id === filter.issuerOwnerId)
          && (filter.status == null || r.status === filter.status))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
        .map((r) => ({ link_ref: r.link_ref, peer_domain: r.peer_domain, status: r.status, expires_at: r.expires_at }));
    },
    // --- federation_directory_links (migration 018) parity ----------------
    // Identical signatures to the Postgres repo. The live-pair uniqueness
    // check is a synchronous scan mirroring the partial unique index
    // `federation_directory_links_live_pair_uidx`. The confirmation CAS
    // replicates the `status='pending' AND <side>_confirmed_at IS NULL`
    // guard as an `if`, so a revoked / expired / active row is never moved
    // back. All in-place status flips run with no interleaved `await`;
    // getters return `fdlRowView` copies, never the live Map row. `client`
    // is ignored (withTransaction is fn(null)).
    async createFederationDirectoryLink(row) {
      for (const existing of federationDirectoryLinks.values()) {
        if (existing.local_owner_id === row.localOwnerId
          && existing.remote_owner_id === row.remoteOwnerId
          && existing.remote_domain === row.remoteDomain
          && (existing.status === 'pending' || existing.status === 'active')) {
          throw Object.assign(new Error('A pending or active federation directory link already exists for this owner pair'), {
            code: 'FEDERATION_LINK_EXISTS',
            existingLinkRef: existing.link_ref,
          });
        }
      }
      const iso = (v) => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
      const nowIso = new Date().toISOString();
      const stored = {
        link_ref: row.linkRef,
        local_owner_id: row.localOwnerId,
        local_endpoint_id: row.localEndpointId,
        remote_owner_id: row.remoteOwnerId,
        remote_endpoint_id: row.remoteEndpointId,
        remote_domain: row.remoteDomain,
        role: row.role,
        initiated_via: row.initiatedVia ?? 'invite',
        status: row.status,
        local_confirmed_at: iso(row.localConfirmedAt),
        remote_confirmed_at: iso(row.remoteConfirmedAt),
        source_invite_id: row.sourceInviteId ?? null,
        peer_domain: row.peerDomain,
        revoked_at: null,
        revoked_by: null,
        last_reason_code: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      federationDirectoryLinks.set(row.linkRef, stored);
      return fdlRowView(stored);
    },
    async getFederationDirectoryLinkByRef(linkRef) {
      const row = federationDirectoryLinks.get(linkRef);
      return row ? fdlRowView(row) : null;
    },
    async setFederationDirectoryLinkConfirmation(linkRef, side, now) {
      const col = side === 'local' ? 'local_confirmed_at' : 'remote_confirmed_at';
      const otherCol = side === 'local' ? 'remote_confirmed_at' : 'local_confirmed_at';
      const row = federationDirectoryLinks.get(linkRef);
      if (!row || row.status !== 'pending' || row[col] != null) {
        return { updated: 0, activated: false };
      }
      const ts = (now instanceof Date ? now : new Date(now)).toISOString();
      row[col] = ts;
      row.status = row[otherCol] != null ? 'active' : 'pending';
      row.updated_at = ts;
      return { updated: 1, activated: row.status === 'active' };
    },
    async revokeFederationDirectoryLink(linkRef, by, now) {
      const row = federationDirectoryLinks.get(linkRef);
      if (!row || (row.status !== 'pending' && row.status !== 'active')) return { updated: 0 };
      const ts = (now instanceof Date ? now : new Date(now)).toISOString();
      row.status = 'revoked';
      row.revoked_at = ts;
      row.revoked_by = by;
      row.updated_at = ts;
      return { updated: 1 };
    },
    async markFederationDirectoryLinkExpired(linkRef, reasonCode, now) {
      const row = federationDirectoryLinks.get(linkRef);
      if (!row || row.status !== 'pending') return { updated: 0 };
      const ts = (now instanceof Date ? now : new Date(now)).toISOString();
      row.status = 'expired';
      row.last_reason_code = reasonCode;
      row.updated_at = ts;
      return { updated: 1 };
    },
    async listFederationDirectoryLinks(filter = {}) {
      return [...federationDirectoryLinks.values()]
        .filter((r) => (filter.status == null || r.status === filter.status)
          && (filter.role == null || r.role === filter.role)
          && (filter.ownerId == null || r.local_owner_id === filter.ownerId))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
        .map((r) => ({
          link_ref: r.link_ref,
          role: r.role,
          local_owner_id: r.local_owner_id,
          remote_owner_id: r.remote_owner_id,
          remote_domain: r.remote_domain,
          status: r.status,
          local_confirmed_at: r.local_confirmed_at,
          remote_confirmed_at: r.remote_confirmed_at,
        }));
    },
    async getActiveFederationDirectoryLink(localOwnerId, remoteOwnerId, remoteDomain) {
      for (const row of federationDirectoryLinks.values()) {
        if (row.status === 'active'
          && row.local_owner_id === localOwnerId
          && row.remote_owner_id === remoteOwnerId
          && row.remote_domain === remoteDomain) {
          return fdlRowView(row);
        }
      }
      return null;
    },
    // Owner-pair collision probe for acceptDirectoryRedemption (Task 8): any
    // `status IN ('pending','active')` row for this triple, or null. Mirrors
    // the partial unique index `federation_directory_links_live_pair_uidx`;
    // used to reject a redemption *before* the invite is marked redeemed so a
    // colliding invite stays `pending`.
    async findLiveFederationDirectoryLinkForPair(localOwnerId, remoteOwnerId, remoteDomain) {
      for (const row of federationDirectoryLinks.values()) {
        if ((row.status === 'pending' || row.status === 'active')
          && row.local_owner_id === localOwnerId
          && row.remote_owner_id === remoteOwnerId
          && row.remote_domain === remoteDomain) {
          return fdlRowView(row);
        }
      }
      return null;
    },
    // Relay-to-relay replay guard (migration 019). Parity with the Postgres
    // consumeRelayNonce: a repeat nonce throws RELAY_REPLAYED; pruneRelayNonces
    // sweeps entries whose expires_at is before `now`.
    async consumeRelayNonce(nonce, { expiresAt } = {}) {
      if (federationRelayNonces.has(nonce)) {
        throw Object.assign(new Error('relay request nonce already seen'), { code: 'RELAY_REPLAYED' });
      }
      const iso = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
      federationRelayNonces.set(nonce, iso);
    },
    async pruneRelayNonces(now = new Date()) {
      const cutoff = (now instanceof Date ? now : new Date(now)).toISOString();
      let deleted = 0;
      for (const [nonce, exp] of federationRelayNonces) {
        if (exp < cutoff) { federationRelayNonces.delete(nonce); deleted += 1; }
      }
      return { deleted };
    },
    _debugGetEnvelope(messageId) { return envelopes.get(messageId) ?? null; }
  };
}
