-- Bind an approval challenge to the exact signed envelope a human is asked to approve.
-- All columns are nullable: challenges created with only an action_hash (older callers)
-- carry no envelope and keep working. The envelope is the full signed envelope; the relay
-- recomputes its canonical hash and verifies its signature before storing it, so what the
-- approval page shows cannot differ from the bytes the approval authorizes.
ALTER TABLE approval_challenges
  ADD COLUMN conversation_id TEXT,
  ADD COLUMN message_id TEXT,
  ADD COLUMN capabilities TEXT[],
  ADD COLUMN envelope JSONB,
  ADD CONSTRAINT approval_challenges_envelope_columns_together CHECK (
    (envelope IS NULL AND conversation_id IS NULL AND message_id IS NULL AND capabilities IS NULL)
    OR (envelope IS NOT NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL AND capabilities IS NOT NULL)
  );

CREATE INDEX approval_challenges_conversation_idx ON approval_challenges (conversation_id, status)
  WHERE conversation_id IS NOT NULL;
