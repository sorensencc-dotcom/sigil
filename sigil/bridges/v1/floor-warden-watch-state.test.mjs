import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, EVENTS, TRANSITIONS, deriveWatchState, snapshotFor, canWatchEvent, applyWatchEvent, emptyWatch,
} from './floor-warden-watch-state.mjs';

test('deriveWatchState names each approved flag combination', () => {
  assert.equal(deriveWatchState(snapshotFor('Idle')), 'Idle');
  assert.equal(deriveWatchState(snapshotFor('AttemptsPending')), 'AttemptsPending');
  assert.equal(deriveWatchState(snapshotFor('ArmedNoForward')), 'ArmedNoForward');
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

test('accidental: Closed handle.forwarded writes a forward and does not arm', () => {
  const result = applyWatchEvent(snapshotFor('Closed'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 1000,
  });
  assert.equal(result.rejected, false);
  assert.equal(result.accidental, true);
  assert.equal(result.to, 'Closed');
  assert.ok(result.snapshot.forward);
  assert.equal(result.snapshot.watch, null);
});

test('accidental: ArmedNoForward handle.forwarded becomes Watching', () => {
  const result = applyWatchEvent(snapshotFor('ArmedNoForward'), 'handle.forwarded', {
    forward: { trigger_message_id: 'msg_t' },
    deadlineAt: 50,
  });
  assert.equal(result.accidental, true);
  assert.equal(result.to, 'Watching');
});

test('recover.fail.retry does not re-arm an OrphanForward', () => {
  const result = applyWatchEvent(snapshotFor('OrphanForward'), 'recover.fail.retry');
  assert.equal(result.rejected, false);
  assert.equal(result.accidental, true);
  assert.equal(result.to, 'OrphanForward');
  assert.equal(result.snapshot.watch, null);
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

test('handle.fail.retry from Idle is ArmedNoForward', () => {
  const result = applyWatchEvent(snapshotFor('Idle'), 'handle.fail.retry', { reason: 'FLOOR_WARDEN_REJECTED', deadlineAt: 1 });
  assert.equal(result.to, 'ArmedNoForward');
  assert.equal(result.snapshot.watch.reason, 'FLOOR_WARDEN_REJECTED');
  assert.equal(result.snapshot.forward, null);
});

test('emptyWatch starts counters at zero', () => {
  assert.deepEqual(emptyWatch('REPLY_TIMEOUT', 9), {
    reason: 'REPLY_TIMEOUT', deadlineAt: 9, haltAttempts: 0, errors: 0, deadlineErrors: 0, busy: false,
  });
});
