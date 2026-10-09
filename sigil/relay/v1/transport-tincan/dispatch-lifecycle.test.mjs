import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDeliveryWithRetry } from './dispatch-lifecycle.mjs';

const delivery = { conversation_id: 'room_1', invocation_id: 'inv_1' };
const timeout = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });

function harness(overrides = {}) {
  const fails = [];
  let clock = 0;
  return {
    fails,
    args: {
      delivery,
      failFn: async (roomId, reason, invocationId) => { fails.push({ roomId, reason, invocationId }); },
      sleepFn: async (ms) => { clock += ms; },
      nowFn: () => clock,
      ...overrides,
    },
  };
}

test('succeeds on the second attempt without failing the invocation', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { if (++calls === 1) throw timeout(); return { status: 'DELIVERED' }; } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'DELIVERED' });
  assert.equal(calls, 2);
  assert.deepEqual(fails, []);
});

test('three timeouts fail the invocation once with wake_timeout', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { calls++; throw timeout(); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_timeout' });
  assert.equal(calls, 3);
  assert.deepEqual(fails, [{ roomId: 'room_1', reason: 'wake_timeout', invocationId: 'inv_1' }]);
});

test('a crashed child fails immediately with wake_process_failed and no retry', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { calls++; throw Object.assign(new Error('exit 1'), { exitCode: 1 }); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_process_failed' });
  assert.equal(calls, 1);
  assert.equal(fails[0].reason, 'wake_process_failed');
});

test('the 45 second budget stops retries early', async () => {
  let calls = 0;
  const { fails, args } = harness({ timeoutBudgetMs: 20000, backoffMs: [25000, 25000], wakeFn: async () => { calls++; throw timeout(); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_timeout' });
  assert.equal(calls, 1, 'the first backoff alone exceeds the budget');
  assert.equal(fails.length, 1);
});
