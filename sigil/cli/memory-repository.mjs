// In-memory stand-in for the PostgreSQL repository the relay expects
// (see relay/v1/postgres-repository.mjs). Enough of the interface to run
// a real local relay for a demo or single-machine session. State lives
// only in this process -- restarting `sigil relay up` loses history.
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';

export function createMemoryRepository() {
  const envelopes = new Map();
  const deliveries = new Map();
  return {
    async persistAcceptedEnvelope(row) {
      envelopes.set(row.message_id, row);
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
    }
  };
}
