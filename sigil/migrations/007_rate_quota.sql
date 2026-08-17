-- Rolling-window rate limits for endpoint/owner/conversation (design §8).
-- Inbox depth (recipient) is NOT here -- it's derived live from `deliveries`
-- rows in Task 14, since it's a depth limit (must decrement), not a rate.
CREATE TABLE IF NOT EXISTS quota_usage (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('endpoint', 'owner', 'conversation')),
  scope_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (scope_kind, scope_id, window_start)
);

CREATE INDEX IF NOT EXISTS quota_usage_window_idx ON quota_usage(scope_kind, scope_id, window_start);
