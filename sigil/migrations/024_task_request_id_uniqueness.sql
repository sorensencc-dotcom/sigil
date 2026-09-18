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
--
-- Devin review, PR #5: the schema this index tightens is exactly the one the
-- vulnerability being repaired exploited, so an already-attacked database
-- can hold accepted (conversation_id, task_id) duplicates today -- and
-- CREATE UNIQUE INDEX aborts (blocking relay startup) the moment it finds
-- one. Resolve every duplicate group deterministically first: keep the
-- earliest-accepted row 'accepted' (ties broken by message_id, since
-- created_at is client-supplied and not itself unique) and demote the rest
-- to 'superseded_duplicate_task_id'. Demoted rows are neither deleted nor
-- have their FKs touched -- their deliveries, idempotency_keys and
-- audit_events rows are untouched and still resolve -- they simply drop out
-- of the 'accepted'-scoped partial index (and every other 'accepted'-scoped
-- lookup: lookupTaskRequest, lookupAcceptedMessageId, resend replay), the
-- same visibility change accept-envelope.mjs now enforces for anything
-- submitted after this migration.
WITH ranked AS (
  SELECT message_id,
         ROW_NUMBER() OVER (
           PARTITION BY conversation_id, (body->>'task_id')
           ORDER BY created_at ASC, message_id ASC
         ) AS rn
  FROM envelopes
  WHERE message_type = 'task.request' AND envelope_status = 'accepted'
)
UPDATE envelopes
SET envelope_status = 'superseded_duplicate_task_id'
WHERE message_id IN (SELECT message_id FROM ranked WHERE rn > 1);

DROP INDEX IF EXISTS envelopes_task_request_lookup_idx;
CREATE UNIQUE INDEX IF NOT EXISTS envelopes_task_request_lookup_idx
ON envelopes (conversation_id, (body->>'task_id'))
WHERE message_type = 'task.request' AND envelope_status = 'accepted';
