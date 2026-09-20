import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./026_agentmail_control_capabilities.sql', import.meta.url), 'utf8');
test('migration registers explicit AgentMail control capabilities without grants', () => {
  for (const capability of ['control_drain', 'control_disable', 'control_resume', 'control_rotate', 'control_emergency_stop']) assert.match(sql, new RegExp(`sigil\\.agentmail/${capability}`));
  assert.doesNotMatch(sql, /capability_grants/);
});
