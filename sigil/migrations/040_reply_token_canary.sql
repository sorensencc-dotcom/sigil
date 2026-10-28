-- Planted Floor Warden reply-token canaries: status 'canary' never authorizes a reply.
ALTER TABLE floor_warden_reply_tokens DROP CONSTRAINT IF EXISTS floor_warden_reply_tokens_status_check;
ALTER TABLE floor_warden_reply_tokens ADD CONSTRAINT floor_warden_reply_tokens_status_check
  CHECK (status IN ('active', 'retired', 'revoked', 'canary'));
