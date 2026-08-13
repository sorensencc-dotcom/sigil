import { transitionDelivery } from './delivery-state.mjs';

export function reportProcessing(delivery, report, options = {}) {
  if (!report || !['processing', 'processing_failed'].includes(report.state)) {
    return { status: 400, body: { request_id: options.request_id ?? null, code: 'INVALID_ENVELOPE', message: 'Report state must be processing or processing_failed', details: {} } };
  }
  try {
    const next = transitionDelivery(delivery, report.state, { ...options, reason: report.reason ?? null });
    options.persist?.(next);
    return { status: 204, body: null, delivery: next };
  } catch (error) {
    const code = error.code === 'INVALID_STATE_TRANSITION' ? 'DELIVERY_UNAVAILABLE' : (error.code ?? 'DELIVERY_UNAVAILABLE');
    return { status: 409, body: { request_id: options.request_id ?? null, code, message: error.message, details: {} } };
  }
}
