-- Rooms phase 3 fix: a router decision writes one room_invocations row per
-- endpoint it names (invoked or refused), so a decision that touches two or
-- more endpoints shares one trigger_message_id across rows. The 030 index
-- allowed only one router row per trigger message and failed those decisions
-- with 23505. Idempotency is kept by the room row lock, the router-decision
-- lookup, and the router event idempotency key, with the
-- (trigger_message_id, endpoint_id) unique constraint as the backstop.
DROP INDEX IF EXISTS room_invocations_one_router_decision_idx;
