-- Partial expression index for F2 task cross-reference lookups (design §3).
-- Optimizes lookupTaskRequest queries:
-- SELECT message_id FROM envelopes
-- WHERE conversation_id = $1 AND message_type = 'task.request'
--   AND body->>'task_id' = $2 AND envelope_status = 'accepted'
CREATE INDEX IF NOT EXISTS envelopes_task_request_lookup_idx
ON envelopes (conversation_id, (body->>'task_id'))
WHERE message_type = 'task.request' AND envelope_status = 'accepted';
