// In-memory stand-in for the PostgreSQL repository the relay expects
// (see relay/v1/postgres-repository.mjs). Enough of the interface to run
// a real local relay for a demo or single-machine session. State lives
// only in this process -- restarting `sigil relay up` loses history.
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';

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

export function createMemoryRepository() {
  const envelopes = new Map();
  const deliveries = new Map();
  const idempotency = new Map();
  return {
    // Single-process, no real client/connection -- the transaction wrapper
    // exists so acceptEnvelopeAsync's repository-aware path works unchanged
    // against this repository too (design §12 dual-repository equivalence).
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency(endpointId, idempotencyKey) {
      return idempotency.get(`${endpointId}:${idempotencyKey}`) ?? null;
    },
    async lookupTaskRequest(taskId, conversationId) {
      for (const row of envelopes.values()) {
        if (row.envelope.conversation_id === conversationId && row.envelope.message_type === 'task.request' && row.envelope.body?.task_id === taskId) {
          return { message_id: row.envelope.message_id };
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
    async persistAcceptedEnvelope(row) {
      envelopes.set(row.message_id, row);
      idempotency.set(`${row.envelope.sender.endpoint_id}:${row.envelope.idempotency_key}`, { message_id: row.message_id, canonical_hash: row.canonical_hash });
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        deliveries.set(deliveryId, {
          delivery_id: deliveryId,
          message_id: row.message_id,
          recipient_endpoint_id: row.envelope.recipient.endpoint_id,
          state: 'delivered',
          queued_at: new Date().toISOString(),
          attempts: 0
        });
      }
      return { message_id: row.message_id, duplicate: false };
    },
    async listInbox(endpointId, since = '') {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.state === 'delivered' && d.queued_at > since)
        .map((d) => ({ delivery_id: d.delivery_id, message_id: d.message_id, envelope: envelopes.get(d.message_id).envelope, queued_at: d.queued_at }));
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
    }
  };
}
