-- Multi-human foundation: kind, suspension marker, one active signing key,
-- custodial key wraps, per-agent invocation policy, invocation subject.

ALTER TABLE endpoints ADD COLUMN kind TEXT;
UPDATE endpoints SET kind = CASE runtime WHEN 'relay' THEN 'system' WHEN 'human' THEN 'human' ELSE 'agent' END;
ALTER TABLE endpoints ALTER COLUMN kind SET NOT NULL;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_kind_check CHECK (kind IN ('human','agent','system'));
ALTER TABLE endpoints ADD COLUMN suspended_by_human_id TEXT NULL REFERENCES humans(human_id);

-- Shadow (federated) endpoints: keep only the newest active key.
UPDATE endpoint_keys k SET status = 'retired', valid_until = GREATEST(NOW(), k.valid_from)
 WHERE k.status = 'active'
   AND EXISTS (SELECT 1 FROM endpoints e WHERE e.endpoint_id = k.endpoint_id AND e.origin_domain IS NOT NULL)
   AND EXISTS (SELECT 1 FROM endpoint_keys n WHERE n.endpoint_id = k.endpoint_id AND n.status = 'active'
                AND (n.valid_from, n.key_id) > (k.valid_from, k.key_id));

DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(endpoint_id, ', ') INTO dup FROM (
    SELECT endpoint_id FROM endpoint_keys WHERE status = 'active' GROUP BY endpoint_id HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'endpoints with more than one active key, retire the extras by hand: %', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX endpoint_keys_one_active_idx ON endpoint_keys (endpoint_id) WHERE status = 'active';

CREATE TABLE human_signing_keys (
  key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id),
  wrapped_private_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE conversation_members ADD COLUMN invokable_by TEXT NOT NULL DEFAULT 'owner' CHECK (invokable_by IN ('owner','members'));

ALTER TABLE room_invocations ADD COLUMN subject_human_id TEXT REFERENCES humans(human_id);
UPDATE room_invocations i SET subject_human_id = e.sender_owner_id
  FROM envelopes e WHERE e.message_id = i.trigger_message_id;
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(invocation_id, ', ') INTO missing FROM room_invocations WHERE subject_human_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'room_invocations without a matching trigger envelope: %', missing;
  END IF;
END $$;
ALTER TABLE room_invocations ALTER COLUMN subject_human_id SET NOT NULL;
