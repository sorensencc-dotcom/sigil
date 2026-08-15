-- Persistent, restart-safe idempotency receipt for ack_delivery.
-- One row per delivery: the first successful ack wins and is durably recorded
-- here, independent of how far `deliveries.state` has since advanced. Retries
-- of the same ack become a no-op read of this table instead of re-running the
-- state transition; an ack from a different endpoint than the original is a
-- conflict, not a replay.
CREATE TABLE delivery_acknowledgements (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries(delivery_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  acknowledged_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX delivery_acknowledgements_endpoint_idx ON delivery_acknowledgements(endpoint_id, acknowledged_at);
