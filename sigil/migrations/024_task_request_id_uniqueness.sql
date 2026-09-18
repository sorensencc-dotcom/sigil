-- Security fix (Devin review, PR #4): lookupTaskRequest selects one
-- task.request row per (conversation_id, task_id) with no ordering, so a
-- second, attacker-controlled task.request reusing an existing task_id
-- (self-addressed) could be the row an assignee check resolves against,
-- letting a forged task.result satisfy accept-envelope.mjs's binding to
-- the original assignee. Upgrading the existing lookup index
-- (011_task_request_lookup_index.sql) to UNIQUE makes that duplicate
-- impossible to create in the first place; accept-envelope.mjs additionally
-- rejects it at the application layer with DUPLICATE_TASK_ID for a clean,
-- audited error instead of a raw constraint violation.
DROP INDEX IF EXISTS envelopes_task_request_lookup_idx;
CREATE UNIQUE INDEX IF NOT EXISTS envelopes_task_request_lookup_idx
ON envelopes (conversation_id, (body->>'task_id'))
WHERE message_type = 'task.request' AND envelope_status = 'accepted';
