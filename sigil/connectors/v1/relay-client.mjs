import crypto from 'node:crypto';

export class RelayClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl;
    if (!this.baseUrl || !this.fetch) throw new Error('baseUrl and fetch implementation are required');
  }
  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { ...options, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(options.headers ?? {}) } });
    const text = await response.text(); const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw Object.assign(new Error(body?.message ?? `Relay request failed: ${response.status}`), { code: body?.code ?? 'DELIVERY_UNAVAILABLE', status: response.status, details: body?.details ?? {} });
    return body;
  }
  async sendEnvelope(envelope, requestId = crypto.randomUUID()) { return this.request('/v1/envelopes', { method: 'POST', headers: { 'x-sigil-request-id': requestId }, body: JSON.stringify(envelope) }); }
  async pollInbox(since = '') { return this.request(`/v1/inbox?since=${encodeURIComponent(since)}`); }
  async reconcileInbox(since = '') {
    const page = await this.pollInbox(since);
    return { items: page.items ?? [], nextSince: page.next_since ?? since };
  }
  async acknowledge(deliveryId, { outcome = 'acknowledged', reason = null } = {}) {
    if (outcome === 'delivery_rejected' || outcome === 'rejected') {
      return this.reportProcessing(deliveryId, 'delivery_rejected', reason);
    }
    if (outcome === 'processing_failed' || outcome === 'failed') {
      return this.reportProcessing(deliveryId, 'processing_failed', reason);
    }
    if (outcome === 'processed') {
      return this.reportProcessing(deliveryId, 'processed', reason);
    }
    if (outcome !== 'acknowledged') {
      throw Object.assign(new Error(`Invalid delivery outcome: ${outcome}`), { code: 'INVALID_ENVELOPE' });
    }
    return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, { method: 'POST', body: JSON.stringify({ outcome, reason }) });
  }
  async reportProcessing(deliveryId, state, reason = null) { return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/processing`, { method: 'POST', body: JSON.stringify({ state, reason }) }); }
  async listRoomMembers(roomId) { return (await this.request(`/v1/rooms/${encodeURIComponent(roomId)}/members`)).items; }
  async listRoomMessages(roomId, afterSeq = '0', limit = 500) {
    const page = await this.request(`/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${encodeURIComponent(afterSeq)}&limit=${limit}`);
    return { items: page.items, next_after_seq: page.next_after_seq };
  }
  async listRoomInvocations(roomId, { endpointId = null, status = null } = {}) {
    const query = new URLSearchParams();
    if (endpointId) query.set('endpoint_id', endpointId);
    if (status) query.set('status', status);
    const suffix = query.size ? `?${query}` : '';
    return (await this.request(`/v1/rooms/${encodeURIComponent(roomId)}/invocations${suffix}`)).items;
  }
  async failRoomInvocation(roomId, reason, invocationId = null) {
    const body = { reason };
    if (invocationId !== null) body.invocation_id = invocationId;
    return (await this.request(`/v1/rooms/${encodeURIComponent(roomId)}/invocations/fail`, { method: 'POST', body: JSON.stringify(body) })).invocation;
  }
  async createRoomInvocations(roomId, { trigger_message_id, invoke, reason = '', failed = false }) {
    return this.request(`/v1/rooms/${encodeURIComponent(roomId)}/invocations`, { method: 'POST', body: JSON.stringify({ trigger_message_id, invoke, reason, ...(failed ? { failed: true } : {}) }) });
  }
}
