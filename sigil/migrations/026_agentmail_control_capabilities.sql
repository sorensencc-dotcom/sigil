INSERT INTO capability_registry (capability, namespace, risk_tier, registered_by, registered_at) VALUES
  ('sigil.agentmail/control_drain', 'sigil.agentmail', 'standard', 'system', NOW()),
  ('sigil.agentmail/control_disable', 'sigil.agentmail', 'standard', 'system', NOW()),
  ('sigil.agentmail/control_resume', 'sigil.agentmail', 'high', 'system', NOW()),
  ('sigil.agentmail/control_rotate', 'sigil.agentmail', 'high', 'system', NOW()),
  ('sigil.agentmail/control_emergency_stop', 'sigil.agentmail', 'high', 'system', NOW())
ON CONFLICT (capability) DO NOTHING;
