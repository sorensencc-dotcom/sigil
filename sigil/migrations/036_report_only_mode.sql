-- Report-only room members post top-level room messages without invocation.
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_response_mode_check;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_response_mode_check
  CHECK (response_mode IS NULL OR response_mode IN ('joins', 'mentions_only', 'router', 'report_only'));

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS report_post BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS envelopes_report_posts_idx
  ON envelopes (conversation_id, created_at)
  WHERE report_post;
