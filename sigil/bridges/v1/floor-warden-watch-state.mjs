// Named Floor Warden invocation-watch states and the transition table.
// Flags still live in the session store plus the in-memory watch; this module
// is the single place that names the derived state and rejects forbidden
// events. FailWatching (unconfirmed fail) is distinct from ArmedNoForward
// (recover of a never-forwarded running invocation) so a fail-watch blocks
// a second POST while recover-then-handle still forwards.
//
// Snapshot: { closed, forward, attempts, halt, watch }
// watch: { reason, deadlineAt, haltAttempts, errors, deadlineErrors, busy, source }

export const STATES = Object.freeze([
  'Idle', 'AttemptsPending', 'ArmedNoForward', 'FailWatching', 'Watching', 'HaltRetrying', 'OrphanForward', 'Halted', 'Closed',
]);

export const EVENTS = Object.freeze([
  'handle.skip', 'handle.forwarded', 'handle.attempts', 'handle.fail.ok', 'handle.fail.retry',
  'poll.running', 'poll.busy', 'poll.halt.ok', 'poll.halt.retry', 'poll.done', 'poll.error',
  'deadline.fail.ok', 'deadline.fail.retry', 'deadline.idle',
  'recover.arm', 'recover.fail.ok', 'recover.fail.retry', 'recover.forget', 'recover.halt.ok',
  'finish', 'close', 'set-busy',
]);

const HAS_WATCH = new Set(['ArmedNoForward', 'FailWatching', 'Watching', 'HaltRetrying']);
const TIMER = new Set([
  'poll.running', 'poll.busy', 'poll.halt.ok', 'poll.halt.retry', 'poll.done', 'poll.error',
  'deadline.fail.ok', 'deadline.fail.retry', 'deadline.idle', 'set-busy',
]);

const FORBIDDEN = new Set([
  'FailWatching|handle.forwarded',
  'Halted|handle.forwarded',
  'Closed|handle.forwarded',
  'Closed|handle.attempts',
  'Closed|handle.fail.retry',
  'Closed|recover.arm',
  'Closed|recover.fail.ok',
  'Closed|recover.fail.retry',
]);

export function emptyWatch(reason = 'REPLY_TIMEOUT', deadlineAt = 0, source = 'recover') {
  return { reason, deadlineAt, haltAttempts: 0, errors: 0, deadlineErrors: 0, busy: false, source };
}

export function deriveWatchState(snapshot) {
  if (snapshot?.closed) return 'Closed';
  if (snapshot?.watch && snapshot.forward && snapshot.watch.haltAttempts > 0) return 'HaltRetrying';
  if (snapshot?.watch && snapshot.forward) return 'Watching';
  if (snapshot?.watch) return snapshot.watch.source === 'fail' ? 'FailWatching' : 'ArmedNoForward';
  if (snapshot?.halt) return 'Halted';
  if (snapshot?.forward) return 'OrphanForward';
  if ((snapshot?.attempts ?? 0) > 0) return 'AttemptsPending';
  return 'Idle';
}

export function snapshotFor(state, extras = {}) {
  const base = { closed: false, forward: null, attempts: 0, halt: null, watch: null };
  const forward = extras.forward ?? { trigger_message_id: 'msg' };
  switch (state) {
    case 'Idle': return { ...base, ...extras, closed: false };
    case 'AttemptsPending': return { ...base, attempts: 1, ...extras, closed: false };
    case 'ArmedNoForward': return { ...base, watch: emptyWatch(), ...extras, closed: false };
    case 'FailWatching': return { ...base, watch: emptyWatch('FLOOR_WARDEN_REJECTED', 0, 'fail'), ...extras, closed: false };
    case 'Watching': return { ...base, forward, watch: emptyWatch(), ...extras, closed: false };
    case 'HaltRetrying': return { ...base, forward, watch: { ...emptyWatch(), haltAttempts: 1 }, ...extras, closed: false };
    case 'OrphanForward': return { ...base, forward, ...extras, closed: false };
    case 'Halted': return { ...base, halt: extras.halt ?? '2026-01-01T00:00:00.000Z', ...extras, closed: false };
    case 'Closed': return { ...base, ...extras, closed: true };
    default: throw new Error(`unknown watch state ${state}`);
  }
}

export const TRANSITIONS = Object.freeze(STATES.flatMap((from) => EVENTS.map((event) => Object.freeze({
  from,
  event,
  forbidden: (TIMER.has(event) && !HAS_WATCH.has(from)) || FORBIDDEN.has(`${from}|${event}`),
}))));

const TRANSITION_INDEX = new Map(TRANSITIONS.map((row) => [`${row.from}|${row.event}`, row]));

export function canWatchEvent(from, event) {
  const row = TRANSITION_INDEX.get(`${from}|${event}`);
  if (!row) return false;
  return !row.forbidden;
}

function clone(snapshot) {
  return {
    closed: Boolean(snapshot?.closed),
    forward: snapshot?.forward ?? null,
    attempts: Number(snapshot?.attempts ?? 0) || 0,
    halt: snapshot?.halt ?? null,
    watch: snapshot?.watch ? { ...snapshot.watch } : null,
  };
}

function finish(snapshot) {
  snapshot.watch = null;
  snapshot.forward = null;
  snapshot.attempts = 0;
  return snapshot;
}

function arm(snapshot, extra) {
  if (snapshot.closed) return snapshot;
  snapshot.watch = emptyWatch(
    extra?.reason ?? snapshot.watch?.reason ?? 'REPLY_TIMEOUT',
    extra?.deadlineAt ?? snapshot.watch?.deadlineAt ?? 0,
    extra?.source ?? snapshot.watch?.source ?? 'recover',
  );
  return snapshot;
}

const MUTATE = {
  'handle.skip': (s) => s,
  'handle.forwarded': (s, extra) => {
    s.forward = extra?.forward ?? s.forward;
    s.attempts = 0;
    return arm(s, { ...extra, source: 'forward' });
  },
  'handle.attempts': (s, extra) => {
    s.attempts = Number(extra?.attempts ?? s.attempts) || 0;
    return s;
  },
  'handle.fail.ok': finish,
  'handle.fail.retry': (s, extra) => arm(s, { ...extra, source: 'fail' }),
  'poll.running': (s) => {
    if (s.watch) s.watch.errors = 0;
    return s;
  },
  'poll.busy': (s) => s,
  'poll.halt.ok': (s, extra) => {
    s.halt = extra?.halt ?? s.halt ?? new Date().toISOString();
    return finish(s);
  },
  'poll.halt.retry': (s, extra) => {
    if (!s.watch) return s;
    s.watch.haltAttempts += 1;
    if (s.watch.haltAttempts >= (extra?.maxAttempts ?? Infinity)) s.watch = null;
    return s;
  },
  'poll.done': finish,
  'poll.error': (s, extra) => {
    if (!s.watch) return s;
    s.watch.errors += 1;
    if (s.watch.errors >= (extra?.maxAttempts ?? Infinity)) s.watch = null;
    return s;
  },
  'deadline.fail.ok': finish,
  'deadline.fail.retry': (s, extra) => {
    if (!s.watch) return s;
    s.watch.deadlineErrors += 1;
    if (s.watch.deadlineErrors >= (extra?.maxAttempts ?? Infinity)) s.watch = null;
    return s;
  },
  'deadline.idle': (s) => s,
  'recover.arm': (s, extra) => arm(s, { ...extra, source: extra?.source ?? 'recover' }),
  'recover.fail.ok': finish,
  'recover.fail.retry': (s, extra) => arm(s, { ...extra, source: extra?.source ?? 'recover' }),
  'recover.forget': (s) => {
    s.forward = null;
    s.attempts = 0;
    return s;
  },
  'recover.halt.ok': (s, extra) => {
    s.halt = extra?.halt ?? s.halt ?? new Date().toISOString();
    s.forward = null;
    s.attempts = 0;
    return s;
  },
  finish,
  close: (s) => {
    s.closed = true;
    s.watch = null;
    return s;
  },
  'set-busy': (s, extra) => {
    if (s.watch) s.watch.busy = Boolean(extra?.busy);
    return s;
  },
};

export function applyWatchEvent(snapshot, event, extra = {}) {
  const from = deriveWatchState(snapshot);
  const row = TRANSITION_INDEX.get(`${from}|${event}`);
  if (!row || row.forbidden) {
    return { snapshot: clone(snapshot), from, to: from, rejected: true };
  }
  const mutate = MUTATE[event];
  if (!mutate) {
    return { snapshot: clone(snapshot), from, to: from, rejected: true };
  }
  const next = mutate(clone(snapshot), extra);
  return {
    snapshot: next,
    from,
    to: deriveWatchState(next),
    rejected: false,
  };
}
