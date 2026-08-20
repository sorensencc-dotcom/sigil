export function createConnector({ relay, outbox, inbox, requestApproval, resolveContext, processTask, submitResult } = {}) {
  if (!relay || typeof relay.sendEnvelope !== 'function' || typeof relay.reconcileInbox !== 'function') throw new Error('relay client is required');
  if (!outbox || typeof outbox.queue !== 'function' || typeof outbox.markAccepted !== 'function') throw new Error('outbox is required');
  if (!inbox || typeof inbox.receive !== 'function' || typeof inbox.get !== 'function') throw new Error('inbox is required');
  return Object.freeze({
    async sendTask({ envelope } = {}) {
      const queued = outbox.queue(envelope);
      const accepted = await relay.sendEnvelope(queued.envelope);
      outbox.markAccepted(queued.envelope.message_id);
      return accepted;
    },
    async checkInbox(since = '') {
      const page = await relay.reconcileInbox(since);
      for (const item of page.items) {
        inbox.receive(item.envelope ?? item);
        if (item.delivery_id && typeof relay.acknowledge === 'function') await relay.acknowledge(item.delivery_id);
      }
      return { ...page, items: page.items.map((item) => inbox.get(item.message_id ?? item.envelope?.message_id) ?? item) };
    },
    async getResult(taskId) {
      return inbox.get(taskId);
    },
    async ackDelivery(input) {
      const deliveryId = typeof input === 'string' ? input : input?.delivery_id ?? input?.deliveryId;
      const outcome = (typeof input === 'object' ? (input?.outcome ?? 'processed') : 'processed');
      if (!deliveryId) throw Object.assign(new Error('delivery_id is required'), { code: 'INVALID_ENVELOPE' });
      if (typeof relay.acknowledge === 'function') {
        await relay.acknowledge(deliveryId);
      }
      return { delivery_id: deliveryId, outcome };
    },
    async processTask(task) {
      if (typeof processTask !== 'function') throw Object.assign(new Error('Task processor is not configured'), { code: 'PROCESSING_UNAVAILABLE' });
      return processTask(task);
    },
    async processDelivery({ deliveryId, task } = {}) {
      if (!deliveryId || !task) throw Object.assign(new Error('deliveryId and task are required'), { code: 'INVALID_ENVELOPE' });
      await relay.reportProcessing?.(deliveryId, 'processing');
      try {
        const result = await (typeof processTask === 'function' ? processTask(task) : Promise.reject(Object.assign(new Error('Task processor is not configured'), { code: 'PROCESSING_UNAVAILABLE' })));
        return { result, state: 'processed' };
      } catch (error) {
        await relay.reportProcessing?.(deliveryId, 'processing_failed', error.message);
        throw error;
      }
    },
    async submitResult(result) {
      if (typeof submitResult !== 'function') throw Object.assign(new Error('Result submission is not configured'), { code: 'DELIVERY_UNAVAILABLE' });
      return submitResult(result);
    },
    async requestApproval(action) {
      if (typeof requestApproval !== 'function') throw Object.assign(new Error('Approval service is not configured'), { code: 'APPROVAL_REQUIRED' });
      return requestApproval(action);
    },
    async resolveContext(ref) {
      if (typeof resolveContext !== 'function') throw Object.assign(new Error('Context resolver is not configured'), { code: 'CONTEXT_NOT_FOUND' });
      return resolveContext(ref);
    }
  });
}
