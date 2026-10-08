-- Rooms phase 3: the router is a room member with response_mode 'router', and
-- the relay records at most one router decision per trigger message so a
-- retried router call is idempotent.
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_response_mode_check;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_response_mode_check
  CHECK (response_mode IS NULL OR response_mode IN ('joins', 'mentions_only', 'router'));

CREATE UNIQUE INDEX IF NOT EXISTS room_invocations_one_router_decision_idx
  ON room_invocations (trigger_message_id)
  WHERE decided_by = 'router';
