// Exhaustive walk of applyWatchEvent on the real reducer.
// Every reachable named state × every event × bounded extras.
import {
  STATES, EVENTS, applyWatchEvent, snapshotFor, deriveWatchState,
} from '../../sigil/bridges/v1/floor-warden-watch-state.mjs';

export const FORBIDDEN_PAIRS = Object.freeze([
  'FailWatching|handle.forwarded',
  'Halted|handle.forwarded',
  'Closed|handle.forwarded',
  'Closed|handle.attempts',
  'Closed|handle.fail.retry',
  'Closed|recover.arm',
  'Closed|recover.fail.ok',
  'Closed|recover.fail.retry',
]);

const CLOSED_BLOCKED = Object.freeze([
  'handle.forwarded', 'handle.attempts', 'handle.fail.retry',
  'recover.arm', 'recover.fail.ok', 'recover.fail.retry',
]);

const EXHAUST = new Set(['deadline.fail.retry', 'poll.error', 'poll.halt.retry']);

const EXTRAS = Object.freeze([
  { id: '{}', value: {} },
  { id: 'maxAttempts=1', value: { maxAttempts: 1 } },
  { id: 'maxAttempts=2', value: { maxAttempts: 2 } },
  { id: 'attempts=1', value: { attempts: 1 } },
  { id: 'forward+fail', value: { forward: { trigger_message_id: 'msg' }, deadlineAt: 1, source: 'fail' } },
  { id: 'forward+recover', value: { forward: { trigger_message_id: 'msg' }, deadlineAt: 1, source: 'recover' } },
]);

function cap(n) {
  return Math.min(Number(n) || 0, 3);
}

function canon(snapshot) {
  const watch = snapshot.watch;
  return JSON.stringify({
    c: Boolean(snapshot.closed),
    f: Boolean(snapshot.forward),
    a: snapshot.attempts > 0 ? 1 : 0,
    h: Boolean(snapshot.halt),
    w: watch ? {
      ha: cap(watch.haltAttempts),
      e: cap(watch.errors),
      d: cap(watch.deadlineErrors),
      src: watch.source ?? 'recover',
      b: Boolean(watch.busy),
    } : null,
  });
}

function stepWords(from, event, extraId, to, rejected) {
  const extra = extraId === '{}' ? '' : `(${extraId})`;
  return rejected ? `${from} rejects ${event}${extra}` : `${from} --${event}${extra}--> ${to}`;
}

function note(broken, name, path, detail) {
  if (broken[name]) return;
  broken[name] = { path, detail };
}

export function explore() {
  const broken = {};
  const queue = [];
  const seen = new Set();
  let edges = 0;

  for (const state of STATES) {
    const snap = snapshotFor(state);
    const key = canon(snap);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ snapshot: snap, path: [] });
  }

  while (queue.length) {
    const { snapshot, path } = queue.shift();
    const from = deriveWatchState(snapshot);

    if (from === 'OrphanForward') {
      const retry = applyWatchEvent(snapshot, 'recover.fail.retry', { reason: 'REPLY_TIMEOUT', deadlineAt: 1 });
      if (retry.rejected || !retry.snapshot.watch) {
        note(broken, 'failed-recover-rearms', path.concat([stepWords(from, 'recover.fail.retry', '{}', retry.to, retry.rejected)]),
          'OrphanForward recover.fail.retry must arm a watch so a failed timeout confirm is retried');
      }
    }

    for (const event of EVENTS) {
      for (const extra of EXTRAS) {
        const result = applyWatchEvent(snapshot, event, extra.value);
        edges += 1;
        const pair = `${from}|${event}`;
        const nextPath = path.concat([stepWords(from, event, extra.id, result.to, result.rejected)]);

        if (FORBIDDEN_PAIRS.includes(pair) && !result.rejected) {
          note(broken, 'forbidden-never-accepted', nextPath, `accepted forbidden ${pair}`);
        }
        if (from === 'FailWatching' && event === 'handle.forwarded' && !result.rejected) {
          note(broken, 'fail-watching-blocks-forward', nextPath, 'FailWatching accepted handle.forwarded; a second POST would run the bot twice');
        }
        if (from === 'Halted' && event === 'handle.forwarded' && !result.rejected) {
          note(broken, 'halted-blocks-forward', nextPath, 'Halted accepted handle.forwarded');
        }
        if (from === 'Closed' && CLOSED_BLOCKED.includes(event) && !result.rejected) {
          note(broken, 'closed-blocks-handle-recover', nextPath, `Closed accepted ${event}; close is a hard shutdown`);
        }
        if (snapshot.closed && !result.snapshot.closed) {
          note(broken, 'closed-stays-closed', nextPath, 'closed snapshot became open');
        }
        if (
          from === 'FailWatching'
          && !result.rejected
          && EXHAUST.has(event)
          && extra.value.maxAttempts === 1
          && !result.snapshot.watch
          && !result.snapshot.closed
          && !result.snapshot.halt
        ) {
          note(broken, 'fail-watch-exhaustion-unwatched', nextPath,
            'exhausting a fail-watch with no forward dropped the watch and left Idle; a running invocation is unwatched until recover');
        }

        if (result.rejected) continue;
        const key = canon(result.snapshot);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ snapshot: result.snapshot, path: nextPath });
      }
    }
  }

  return { visited: seen.size, edges, broken };
}
