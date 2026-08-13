const transitions = Object.freeze({
  queued: new Set(['delivered', 'delivery_rejected']),
  delivered: new Set(['acknowledged', 'delivery_rejected']),
  acknowledged: new Set(['processing', 'delivery_rejected']),
  processing: new Set(['processed', 'processing_failed']),
  processing_failed: new Set(['processing', 'dead_letter']),
  processed: new Set(),
  delivery_rejected: new Set(),
  dead_letter: new Set()
});

export function canTransition(from, to) {
  return transitions[from]?.has(to) ?? false;
}

export function transitionDelivery(delivery, to, { now = new Date(), maxAttempts = 3, reason = null } = {}) {
  if (!delivery || typeof delivery !== 'object') throw new Error('Delivery is required');
  if (!canTransition(delivery.state, to)) {
    const error = new Error(`Invalid delivery transition: ${delivery.state} -> ${to}`);
    error.code = 'INVALID_STATE_TRANSITION';
    throw error;
  }
  const attempts = Number.isInteger(delivery.attempts) ? delivery.attempts : 0;
  if (to === 'processing' && delivery.state === 'processing_failed' && attempts >= maxAttempts) {
    return transitionDelivery(delivery, 'dead_letter', { now, maxAttempts, reason: reason ?? 'retry limit exceeded' });
  }
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const next = { ...delivery, state: to, updated_at: timestamp };
  if (to === 'delivered') next.delivered_at = timestamp;
  if (to === 'acknowledged') next.acknowledged_at = timestamp;
  if (to === 'processing') {
    next.processing_at = timestamp;
    next.attempts = attempts + 1;
  }
  if (to === 'processed') next.processed_at = timestamp;
  if (to === 'processing_failed' || to === 'delivery_rejected' || to === 'dead_letter') next.failure_reason = reason ?? 'unspecified';
  return next;
}
