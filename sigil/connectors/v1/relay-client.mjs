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
  async acknowledge(deliveryId) { return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, { method: 'POST' }); }
  async reportProcessing(deliveryId, state, reason = null) { return this.request(`/v1/deliveries/${encodeURIComponent(deliveryId)}/processing`, { method: 'POST', body: JSON.stringify({ state, reason }) }); }
}
