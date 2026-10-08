// Maps the relay's `deliveries.state` to what a sender sees. `read` means the
// recipient's client acked; it does not prove a person or model read the
// message. `failed` can be current-state rather than final, because
// `processing_failed` may retry (delivery-state.mjs).
const MAPPED = Object.freeze({
  queued: 'queued',
  delivered: 'delivered',
  acknowledged: 'read',
  processing: 'read',
  processed: 'processed',
  delivery_rejected: 'failed',
  processing_failed: 'failed',
  dead_letter: 'failed',
});

export function mapReceiptState(rawState) {
  return MAPPED[rawState] ?? 'unknown';
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// The timestamp that matches the state. The in-memory repository never sets
// `delivered_at`, so `delivered` falls back to `queued_at`.
export function receiptTimestamp(row) {
  switch (row.state) {
    case 'delivered': return iso(row.delivered_at) ?? iso(row.queued_at);
    case 'acknowledged': return iso(row.acknowledged_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'processing': return iso(row.processing_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'processed': return iso(row.processed_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'delivery_rejected':
    case 'processing_failed':
    case 'dead_letter': return iso(row.updated_at) ?? iso(row.queued_at);
    default: return iso(row.queued_at);
  }
}

export function toReceiptRow(row) {
  return {
    recipient_endpoint_id: row.recipient_endpoint_id,
    state: mapReceiptState(row.state),
    raw_state: row.state,
    at: receiptTimestamp(row),
  };
}
