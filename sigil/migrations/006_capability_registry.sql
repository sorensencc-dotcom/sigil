-- sigil/migrations/006_capability_registry.sql
-- Fail-closed capability registry (design §7): a capability not found here
-- is rejected with CAPABILITY_DENIED before scope matching runs at all,
-- regardless of whether its name looks sigil.core/*-shaped.
CREATE TABLE IF NOT EXISTS capability_registry (
  capability TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'standard', 'high')),
  registered_by TEXT,
  registered_at TIMESTAMPTZ NOT NULL
);

INSERT INTO capability_registry (capability, namespace, risk_tier, registered_by, registered_at) VALUES
  ('sigil.core/read_shared_context', 'sigil.core', 'standard', 'system', NOW()),
  ('sigil.core/broadcast_message', 'sigil.core', 'standard', 'system', NOW()),
  ('sigil.task/submit', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.task/read_inbox', 'sigil.task', 'low', 'system', NOW()),
  ('sigil.task/read_result', 'sigil.task', 'low', 'system', NOW()),
  ('sigil.task/process', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.task/submit_result', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.approval/request', 'sigil.approval', 'high', 'system', NOW())
ON CONFLICT (capability) DO NOTHING;
