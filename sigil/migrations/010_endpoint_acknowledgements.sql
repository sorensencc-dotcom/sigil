CREATE TABLE IF NOT EXISTS endpoint_acknowledgements (
  viewer_owner_id TEXT NOT NULL REFERENCES humans(human_id),
  acknowledged_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  acknowledged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (viewer_owner_id, acknowledged_endpoint_id)
);
