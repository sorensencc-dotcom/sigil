import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFloorWarden, RECURSION_LIMIT } from '../sigil/bridges/v1/floor-warden-bridge.mjs';

test('Floor Warden inspectMessage permits valid first-time messages within recursion limits', async () => {
  const warden = createFloorWarden({ maxRecursionHops: 10 });

  const res = await warden.inspectMessage({
    roomId: 'room_alpha',
    replyId: 'reply_001',
    agentId: 'ep_chief',
    hopCount: 1
  });

  assert.equal(res.allowed, true);
  assert.equal(res.action, 'PASS');
});

test('Floor Warden enforces reply idempotency and drops duplicate reply_id without throwing', async () => {
  const warden = createFloorWarden();

  // First dispatch: PASS
  const first = await warden.inspectMessage({
    roomId: 'room_alpha',
    replyId: 'reply_unique_101',
    agentId: 'ep_chief',
    hopCount: 2
  });
  assert.equal(first.allowed, true);
  assert.equal(first.action, 'PASS');

  // Second duplicate dispatch: DROP with DUPLICATE_NONCE
  const duplicate = await warden.inspectMessage({
    roomId: 'room_alpha',
    replyId: 'reply_unique_101',
    agentId: 'ep_chief',
    hopCount: 2
  });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.action, 'DROP');
  assert.equal(duplicate.halt_reason, 'DUPLICATE_NONCE');
  assert.ok(duplicate.details.includes('Duplicate reply_id'));
});

test('Floor Warden halt detector triggers on recursion depth exceeding 10 hops', async () => {
  const warden = createFloorWarden({ maxRecursionHops: 10 });

  // 10 hops is allowed (threshold)
  const atLimit = await warden.inspectMessage({
    roomId: 'room_beta',
    replyId: 'reply_hop_10',
    agentId: 'ep_helix_ci',
    hopCount: 10
  });
  assert.equal(atLimit.allowed, true);
  assert.equal(atLimit.action, 'PASS');

  // 11 hops triggers HALT_AGENT with RECURSION_LIMIT
  const overLimit = await warden.inspectMessage({
    roomId: 'room_beta',
    replyId: 'reply_hop_11',
    agentId: 'ep_helix_ci',
    hopCount: 11
  });
  assert.equal(overLimit.allowed, false);
  assert.equal(overLimit.action, 'HALT_AGENT');
  assert.equal(overLimit.halt_reason, 'RECURSION_LIMIT');
});

test('Floor Warden enforces capability token matching', async () => {
  const warden = createFloorWarden();

  // Valid capability token: PASS
  const valid = await warden.inspectMessage({
    roomId: 'room_gamma',
    replyId: 'reply_cap_01',
    agentId: 'ep_chief',
    capabilityToken: 'tok_valid_ops',
    validTokens: ['tok_valid_ops', 'tok_admin']
  });
  assert.equal(valid.allowed, true);
  assert.equal(valid.action, 'PASS');

  // Invalid capability token: HALT_AGENT with CAPABILITY_BREACH
  const invalid = await warden.inspectMessage({
    roomId: 'room_gamma',
    replyId: 'reply_cap_02',
    agentId: 'ep_chief',
    capabilityToken: 'tok_unauthorized',
    validTokens: ['tok_valid_ops', 'tok_admin']
  });
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.action, 'HALT_AGENT');
  assert.equal(invalid.halt_reason, 'CAPABILITY_BREACH');
});

test('Floor Warden handleHaltRecovery dispatches alert and halts session cleanly', async () => {
  const alertsSent = [];
  const warden = createFloorWarden({
    onAlert: (alert) => { alertsSent.push(alert); }
  });

  const verdict = {
    allowed: false,
    action: 'HALT_AGENT',
    halt_reason: 'RECURSION_LIMIT',
    details: 'Recursion loop detected'
  };

  const recovery = await warden.handleHaltRecovery({
    roomId: 'room_delta',
    agentId: 'ep_looping_bot',
    verdict,
    threadRootId: 'msg_root_123'
  });

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.alertDispatched, true);
  assert.equal(recovery.haltEvent.type, 'room_halted');
  assert.equal(recovery.haltEvent.halt.reason, 'RECURSION_LIMIT');
  assert.equal(recovery.haltEvent.thread_root_id, 'msg_root_123');

  // Verify alert dispatched to #ops-alerts
  assert.equal(alertsSent.length, 1);
  assert.equal(alertsSent[0].channel, '#ops-alerts');
  assert.equal(alertsSent[0].agentId, 'ep_looping_bot');

  // Verify session is marked halted and subsequent messages are dropped
  assert.equal(warden.isHalted('room_delta', 'ep_looping_bot'), true);

  const blocked = await warden.inspectMessage({
    roomId: 'room_delta',
    replyId: 'reply_subsequent',
    agentId: 'ep_looping_bot'
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.action, 'DROP');
  assert.ok(blocked.details.includes('is halted'));

  // Clear halt
  warden.clearHalt('room_delta', 'ep_looping_bot');
  assert.equal(warden.isHalted('room_delta', 'ep_looping_bot'), false);
});
