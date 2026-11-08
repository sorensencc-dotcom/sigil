import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, EVENTS, TRANSITIONS, deriveWatchState, snapshotFor, canWatchEvent, applyWatchEvent, emptyWatch,
} from './floor-warden-watch-state.mjs';

test('deriveWatchState names each approved flag combination', () => {
  assert.equal(deriveWatchState(snapshotFor('Idle')), 'Idle');
  assert.equal(deriveWatchState(snapshotFor('AttemptsPending')), 'AttemptsPending');
  assert.equal(deriveWatchState(snapshotFor('ArmedNoForward')), 'ArmedNoForward');
  assert.equal(deriveWatchState(snapshotFor('FailWatching')), 'FailWatching');
  assert.equal(deriveWatchState(snapshotFor('Watching')), 'Watching');
  assert.equal(deriveWatchState(snapshotFor('HaltRetrying')), 'HaltRetrying');
  assert.equal(deriveWatchState(snapshotFor('OrphanForward')), 'OrphanForward');
  assert.equal(deriveWatchState(snapshotFor('Halted')), 'Halted');
  assert.equal(deriveWatchState(snapshotFor('Closed')), 'Closed');
  assert.equal(deriveWatchState(snapshotFor('Closed', { forward: { trigger_message_id: 'msg' } })), 'Closed');
});

test('the transition table covers every state × event and marks timer events without a watch forbidden', () => {
  assert.equal(TRANSITIONS.length, STATES.length * EVENTS.length);
  assert.equal(canWatchEvent('Idle', 'poll.running'), false);
  assert.equal(canWatchEvent('OrphanForward', 'deadline.idle'), false);
  assert.equal(canWatchEvent('Halted', 'poll.done'), false);
  assert.equal(canWatchEvent('Closed', 'deadline.fail.ok'), false);
  assert.equal(canWatchEvent('Watching', 'poll.running'), true);
  assert.equal(canWatchEvent('ArmedNoForward', 'deadline.fail.retry'), true);
  assert.equal(canWatchEvent('FailWatching', 'deadline.fail.retry'), true);
  assert.equal(canWatchEvent('FailWatching', 'handle.forwarded'), false);
  assert.equal(canWatchEvent('Halted', 'handle.forwarded'), false);
  assert.equal(canWatchEvent('Closed', 'handle.forwarded'), false);
  assert.equal(canWatchEvent('Closed', 'recover.fail.ok'), false);
  assert.equal(canWatchEvent('ArmedNoForward', 'handle.forwarded'), true);
});

test('forbidden timer events are rejected and leave the snapshot unchanged', () => {
  const snap = snapshotFor('Idle');
  const result = applyWatchEvent(snap, 'poll.running');
  assert.equal(result.rejected, true);
  assert.equal(result.to, 'Idle');
  assert.equal(result.snapshot.watch, null);
});

test('Idle handle.forwarded becomes Watching and arms a watch', () => {
  const result = applyWatchEvent(snapshotFor('Idle'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 1000,
  });
  assert.equal(result.rejected, false);
  assert.equal(result.to, 'Watching');
  assert.equal(result.snapshot.forward.trigger_message_id, 'msg_t');
  assert.equal(result.snapshot.watch.deadlineAt, 1000);
});

test('Closed handle.forwarded is rejected and leaves the snapshot unchanged', () => {
  const result = applyWatchEvent(snapshotFor('Closed'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 1000,
  });
  assert.equal(result.rejected, true);
  assert.equal(result.to, 'Closed');
  assert.equal(result.snapshot.forward, null);
  assert.equal(result.snapshot.watch, null);
});

test('FailWatching handle.forwarded is rejected', () => {
  const result = applyWatchEvent(snapshotFor('FailWatching'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 50,
  });
  assert.equal(result.rejected, true);
  assert.equal(result.to, 'FailWatching');
  assert.equal(result.snapshot.forward, null);
});

test('Halted handle.forwarded is rejected', () => {
  const result = applyWatchEvent(snapshotFor('Halted'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
  });
  assert.equal(result.rejected, true);
  assert.equal(result.to, 'Halted');
  assert.ok(result.snapshot.halt);
  assert.equal(result.snapshot.forward, null);
});

test('ArmedNoForward handle.forwarded becomes Watching', () => {
  const result = applyWatchEvent(snapshotFor('ArmedNoForward'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 50,
  });
  assert.equal(result.rejected, false);
  assert.equal(result.to, 'Watching');
});

test('recover.fail.retry re-arms an OrphanForward', () => {
  const result = applyWatchEvent(snapshotFor('OrphanForward'), 'recover.fail.retry', {
    reason: 'REPLY_TIMEOUT',
    deadlineAt: 9,
  });
  assert.equal(result.rejected, false);
  assert.equal(result.to, 'Watching');
  assert.equal(result.snapshot.watch.deadlineAt, 9);
  assert.equal(result.snapshot.watch.source, 'recover');
  assert.ok(result.snapshot.forward);
});

test('Closed recover.fail.ok is rejected', () => {
  const result = applyWatchEvent(snapshotFor('Closed', { forward: { trigger_message_id: 'msg' } }), 'recover.fail.ok');
  assert.equal(result.rejected, true);
  assert.equal(result.to, 'Closed');
  assert.ok(result.snapshot.forward);
});

test('halt retries that reach maxAttempts leave OrphanForward', () => {
  const result = applyWatchEvent(snapshotFor('HaltRetrying'), 'poll.halt.retry', { maxAttempts: 2 });
  assert.equal(result.to, 'OrphanForward');
  assert.equal(result.snapshot.watch, null);
  assert.ok(result.snapshot.forward);
});

test('close from Watching is Closed with the forward kept', () => {
  const result = applyWatchEvent(snapshotFor('Watching'), 'close');
  assert.equal(result.to, 'Closed');
  assert.ok(result.snapshot.forward);
  assert.equal(result.snapshot.watch, null);
});

test('handle.fail.retry from Idle is FailWatching', () => {
  const result = applyWatchEvent(snapshotFor('Idle'), 'handle.fail.retry', { reason: 'FLOOR_WARDEN_REJECTED', deadlineAt: 1 });
  assert.equal(result.to, 'FailWatching');
  assert.equal(result.snapshot.watch.reason, 'FLOOR_WARDEN_REJECTED');
  assert.equal(result.snapshot.watch.source, 'fail');
  assert.equal(result.snapshot.forward, null);
});

test('emptyWatch starts counters at zero', () => {
  assert.deepEqual(emptyWatch('REPLY_TIMEOUT', 9), {
    reason: 'REPLY_TIMEOUT', deadlineAt: 9, haltAttempts: 0, errors: 0, deadlineErrors: 0, busy: false, source: 'recover',
  });
});
