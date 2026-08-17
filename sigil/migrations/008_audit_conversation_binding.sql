-- sigil/migrations/008_audit_conversation_binding.sql
-- Nullable: identity/token/grant events legitimately have no conversation
-- context. Populated whenever the audited action has one (design §9).
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(conversation_id);

CREATE INDEX IF NOT EXISTS audit_events_conversation_idx ON audit_events(conversation_id, created_at);
