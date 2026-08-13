import { transitionDelivery } from './delivery-state.mjs';

export class DeliveryQueue {
  #items = new Map();

  enqueue(delivery) { this.#items.set(delivery.delivery_id, { ...delivery, state: 'queued' }); return this.#items.get(delivery.delivery_id); }
  get(id) { return this.#items.get(id) ?? null; }
  transition(id, state, options = {}) {
    const current = this.#items.get(id);
    if (!current) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
    const next = transitionDelivery(current, state, options);
    this.#items.set(id, next);
    return next;
  }
  queued() { return [...this.#items.values()].filter((item) => item.state === 'queued'); }
}
