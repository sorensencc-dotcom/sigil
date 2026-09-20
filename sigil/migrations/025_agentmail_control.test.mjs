import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionControlState } from '../ingress/v1/agentmail-control.mjs';

const sql = fs.readFileSync(new URL('./025_agentmail_control.sql', import.meta.url), 'utf8');

test('migration seeds disabled control state without capability grants', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agentmail_ingress_control/);
  assert.match(sql, /VALUES \('agentmail', 'disabled', 1/);
  assert.doesNotMatch(sql, /capability_grants/);
  assert.match(sql, /CHECK \(state IN \('enabled', 'draining', 'disabled'\)\)/);
});

test('control FSM accepts only explicit legal transitions', () => {
  assert.equal(transitionControlState({ state: 'enabled', version: 1 }, { action: 'drain' }).state, 'draining');
  assert.equal(transitionControlState({ state: 'enabled', version: 1 }, { action: 'disable' }).state, 'disabled');
  assert.equal(transitionControlState({ state: 'draining', version: 1 }, { action: 'disable' }).state, 'disabled');
  assert.equal(transitionControlState({ state: 'disabled', version: 1 }, { action: 'resume', snapshotGeneration: 'g1' }).state, 'enabled');
  assert.equal(transitionControlState({ state: 'enabled', version: 1 }, { action: 'emergency_stop' }).state, 'disabled');
  for (const action of ['drain', 'disable', 'resume']) assert.throws(() => transitionControlState({ state: 'disabled', version: 1 }, { action }), { code: action === 'resume' ? 'CONTROL_STATE_INVALID' : 'CONTROL_STATE_INVALID' });
  assert.throws(() => transitionControlState({ state: 'draining', version: 1 }, { action: 'resume' }), { code: 'CONTROL_STATE_INVALID' });
  assert.throws(() => transitionControlState({ state: 'disabled', version: 1 }, { action: 'resume' }), { code: 'CONTROL_STATE_INVALID' });
});
