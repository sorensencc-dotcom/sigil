// sigil/bridges/v1/floor-warden-bridge.mjs
// Outbound half of the Floor Warden bridge (spec: "Outbound delivery and
// failures", "Catch-up watermarks", "Loop guards" item 3). Handles one
// room.message delivery for one bot endpoint: confirm the relay still has this
// bot invoked for this message, build the payload, and POST it to the one
// "Sigil rooms" webhook. The bot answers later through the relay's reply
// route, so on 2xx the invocation stays running and this bridge only watches
// it: a reply deadline, and a halt frame if the room stops the work.
//
// createFloorWardenBridge(options) -> { handle({ envelope }), recover(), close() }
//   identity        { endpoint_id } of the bot endpoint (a receive-only identity is enough)
//   bot             { bot_id, display_name? }: the Grok Bot id; display_name falls back to the member list
//   relay           RelayClient-like: listRoomInvocations, listRoomMembers, listRoomMessages,
//                   failRoomInvocation, and request('/v1/rooms') for room name, turn cap and recover()
//   sessions        createSessionStore(...) for this bot endpoint
//   fetchImpl       fetch implementation (default globalThis.fetch)
//   webhook         { url, key, keyHeader? }: url and key are secrets read from env by the caller.
//                   keyHeader is "Name" or "Name: Scheme"; default "Authorization: Bearer".
//                   A bare "Authorization" also means Bearer; any other bare name carries the raw key.
//   replyUrl        public relay origin (or base URL); the payload's reply.url is
//                   <replyUrl>/v1/rooms/<room_id>/replies. Empty: every forward fails REPLY_URL_UNSET.
//   replyTimeoutMs  reply deadline after a forward (default 15 minutes)
//   maxAttempts     forward attempts per invocation before FLOOR_WARDEN_UNREACHABLE (default 5)
//   pollIntervalMs  halt / completion poll (default 2000, the CLI bridges' Stop poll)
//   postTimeoutMs   AbortSignal.timeout for each POST (default 10 seconds)
//   retryBackoffMs  waits between in-bridge retries of a retryable forward (default 1s, 2s, 4s);
//                   past the list, or at maxAttempts, the daemon's next poll or a failure takes over
//   sleep           (ms) => Promise, injectable for tests
//   logger          console-like; never receives the webhook URL or key (origin only, errors scrubbed)
//
// handle outcomes: skipped | forwarded | failed (with reason). It throws only
// for a retryable webhook outcome (408, 429, 5xx, network error, timeout), or a
// relay error before the invocation is known, so the daemon leaves the
// delivery unacked and the retry resends the same delivery_key.
//
// Session store value per room (shares the CLI bridges' format):
//   { session_id: null, last_seq_by_thread: { [thread_root_id]: "<room_seq>" },
//     floor_warden: { attempts: { [inv]: n }, forwards: { [inv]: { thread_root_id,
//       trigger_message_id, trigger_room_seq, forwarded_at, bot } }, halts: { [inv]: iso } } }
import { buildForwardPayload, buildHaltPayload, PAYLOAD_MAX_BYTES } from './floor-warden-payload.mjs';
import { applyWatchEvent } from './floor-warden-watch-state.mjs';
import { logHop } from '../../relay/v1/hop-log.mjs';

const DEFAULT_MAX_TURNS = 6;
const PAGE = 500;
const HALT_RECORD_TTL_MS = 24 * 3600_000;
const RETRY = 'FLOOR_WARDEN_RETRY';
// RFC 7230 token: the characters an HTTP header field name may use.
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseKeyHeader(spec) {
  const raw = String(spec ?? 'Authorization: Bearer');
  const colon = raw.indexOf(':');
  const name = (colon === -1 ? raw : raw.slice(0, colon)).trim().toLowerCase();
  let scheme = colon === -1 ? '' : raw.slice(colon + 1).trim();
  if (colon === -1 && name === 'authorization') scheme = 'Bearer';
  if (!HEADER_TOKEN.test(name)) throw Object.assign(new Error('Floor Warden key header name is not a valid HTTP header name'), { code: 'INVALID_CONFIG' });
  return { name, scheme };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return '[webhook]'; }
}

const toSeq = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

export function createFloorWardenBridge({
  identity, bot, relay, sessions, fetchImpl = globalThis.fetch, webhook, replyUrl,
  replyTimeoutMs = 15 * 60_000, maxAttempts = 5, pollIntervalMs = 2000, postTimeoutMs = 10_000, logger = console,
  retryBackoffMs = [1000, 2000, 4000], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const self = identity.endpoint_id;
  if (!webhook?.url || !webhook?.key) throw Object.assign(new Error('Floor Warden webhook URL and key are required'), { code: 'INVALID_CONFIG' });
  const header = parseKeyHeader(webhook.keyHeader);
  const origin = originOf(webhook.url);
  const replyBase = String(replyUrl ?? '').trim().replace(/\/+$/, '');
  const watches = new Map();
  const attemptCounts = new Map();
  let closed = false;

  const secrets = (() => {
    const list = [webhook.url, webhook.url.replace(/\/+$/, ''), encodeURI(webhook.url), webhook.key];
    try {
      const u = new URL(webhook.url);
      list.push(u.href, u.href.replace(/\/+$/, ''));
      if (u.pathname.length > 1) list.push(u.pathname + u.search, u.pathname);
      if (u.search.length > 1) list.push(u.search);
      for (const part of [u.username, u.password]) {
        if (!part) continue;
        list.push(part);
        try { list.push(decodeURIComponent(part)); } catch { /* not percent-encoded */ }
      }
    } catch { /* not a URL: the whole string is listed */ }
    return [...new Set(list.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  })();
  const scrub = (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text ?? ''));
  const warn = (text) => logger.warn?.(scrub(text));

  // ---- session store ----------------------------------------------------
  function roomValue(roomId) {
    const current = sessions.get(roomId) ?? {};
    const fw = current.floor_warden ?? {};
    return {
      ...current,
      session_id: current.session_id ?? null,
      last_seq_by_thread: { ...(current.last_seq_by_thread ?? {}) },
      floor_warden: { attempts: { ...(fw.attempts ?? {}) }, forwards: { ...(fw.forwards ?? {}) }, halts: { ...(fw.halts ?? {}) } },
    };
  }
  function update(roomId, change) {
    const value = roomValue(roomId);
    change(value);
    sessions.set(roomId, value);
  }
  function snapshotOf(roomId, invocationId) {
    const fw = roomValue(roomId).floor_warden;
    const watch = watches.get(invocationId);
    return {
      closed,
      forward: fw.forwards[invocationId] ?? null,
      attempts: Number(fw.attempts[invocationId] ?? 0) || 0,
      halt: fw.halts[invocationId] ?? null,
      watch: watch ? {
        reason: watch.reason,
        deadlineAt: watch.deadlineAt,
        haltAttempts: watch.haltAttempts,
        errors: watch.errors,
        deadlineErrors: watch.deadlineErrors,
        busy: watch.busy,
      } : null,
    };
  }
  function writeSnap(value, invocationId, snap) {
    const fw = value.floor_warden;
    if (snap.forward) fw.forwards[invocationId] = snap.forward;
    else delete fw.forwards[invocationId];
    if (snap.attempts > 0) fw.attempts[invocationId] = snap.attempts;
    else delete fw.attempts[invocationId];
    if (snap.halt) fw.halts[invocationId] = snap.halt;
    else delete fw.halts[invocationId];
  }
  function sessionChanged(before, after) {
    return before.attempts !== after.attempts || before.halt !== after.halt || JSON.stringify(before.forward) !== JSON.stringify(after.forward);
  }
  function applyAndCommit(roomId, invocationId, event, extra = {}) {
    const before = snapshotOf(roomId, invocationId);
    const result = applyWatchEvent(before, event, extra);
    if (result.rejected) return result;
    closed = result.snapshot.closed;
    if (sessionChanged(before, result.snapshot) || extra.patch) {
      update(roomId, (value) => {
        writeSnap(value, invocationId, result.snapshot);
        extra.patch?.(value);
      });
    }
    if (!result.snapshot.forward && result.snapshot.attempts === 0) attemptCounts.delete(invocationId);
    syncWatch(roomId, invocationId, event, result.snapshot);
    return result;
  }
  function forget(roomId, invocationId) {
    applyAndCommit(roomId, invocationId, 'recover.forget');
  }

  // ---- timers -----------------------------------------------------------
  function disarm(invocationId) {
    const watch = watches.get(invocationId);
    if (!watch) return;
    clearTimeout(watch.deadline);
    clearInterval(watch.poll);
    watches.delete(invocationId);
  }
  function startWatch(roomId, invocationId, logical) {
    disarm(invocationId);
    if (closed) return;
    const watch = {
      roomId,
      reason: logical.reason,
      deadlineAt: logical.deadlineAt,
      busy: logical.busy,
      haltAttempts: logical.haltAttempts,
      errors: logical.errors,
      deadlineErrors: logical.deadlineErrors,
      deadline: null,
      poll: null,
    };
    watch.deadline = setTimeout(() => onDeadline(invocationId), Math.max(0, logical.deadlineAt - Date.now()));
    watch.poll = setInterval(() => onPoll(invocationId), pollIntervalMs);
    watches.set(invocationId, watch);
  }
  function syncWatch(roomId, invocationId, event, snap) {
    if (!snap.watch) {
      disarm(invocationId);
      return;
    }
    const restart = event === 'handle.forwarded' || event === 'handle.fail.retry' || event === 'recover.arm';
    if (restart || !watches.has(invocationId)) {
      startWatch(roomId, invocationId, snap.watch);
      return;
    }
    const watch = watches.get(invocationId);
    watch.reason = snap.watch.reason;
    watch.deadlineAt = snap.watch.deadlineAt;
    watch.haltAttempts = snap.watch.haltAttempts;
    watch.errors = snap.watch.errors;
    watch.deadlineErrors = snap.watch.deadlineErrors;
    watch.busy = snap.watch.busy;
    if (event === 'deadline.fail.retry') {
      clearTimeout(watch.deadline);
      watch.deadline = setTimeout(() => onDeadline(invocationId), pollIntervalMs);
    }
  }
  function finish(roomId, invocationId) {
    applyAndCommit(roomId, invocationId, 'finish');
  }
  function arm(roomId, invocationId, deadlineAt, reason = 'REPLY_TIMEOUT') {
    applyAndCommit(roomId, invocationId, 'recover.arm', { reason, deadlineAt });
  }

  async function isRunning(roomId, invocationId) {
    const running = await relay.listRoomInvocations(roomId, { endpointId: self, status: 'running' });
    return running.some((row) => row.invocation_id === invocationId);
  }

  // Relay errors, counted per path: `errors` for consecutive poll reads (a
  // good read resets it) and `deadlineErrors` for the deadline check and its
  // failRoomInvocation, which the poll never resets. At maxAttempts on either
  // counter the watch stops (one warning) but the forward record stays in the
  // session store, so recover() retries it after a restart. Returns true when stopped.
  function watchError(invocationId, watch, what, error, event) {
    const result = applyAndCommit(watch.roomId, invocationId, event, { maxAttempts });
    warn(`floor warden: ${what} for ${invocationId}: ${error?.message ?? String(error)}`);
    if (result.snapshot.watch) return false;
    warn(`floor warden: stopped watching ${invocationId} after ${maxAttempts} consecutive relay errors; recover() retries it`);
    return true;
  }

  async function onDeadline(invocationId) {
    const watch = watches.get(invocationId);
    if (!watch || closed) return;
    try {
      if (await isRunning(watch.roomId, invocationId)) {
        if (closed || watches.get(invocationId) !== watch) return;
        // Rethrows: the record and timers stay until the relay confirms.
        await failConfirmed(watch.roomId, invocationId, watch.reason, 'deadline.fail.ok');
      }
      // Not running: the poll decides between nothing and a halt frame.
    } catch (error) {
      if (closed || watches.get(invocationId) !== watch) return;
      watchError(invocationId, watch, 'deadline check', error, 'deadline.fail.retry');
    }
  }

  async function onPoll(invocationId) {
    const watch = watches.get(invocationId);
    if (!watch || watch.busy || closed) return;
    watch.busy = true;
    try {
      const running = await isRunning(watch.roomId, invocationId);
      watch.errors = 0;
      if (running) return;
      const all = await relay.listRoomInvocations(watch.roomId, { endpointId: self });
      if (closed || watches.get(invocationId) !== watch) return;
      const row = all.find((item) => item.invocation_id === invocationId);
      if (row?.status === 'cancelled') {
        if (!(await sendHalt(watch.roomId, invocationId))) {
          const after = applyAndCommit(watch.roomId, invocationId, 'poll.halt.retry', { maxAttempts });
          if (after.snapshot.watch) return;
          warn(`floor warden: halt frame for ${invocationId} not delivered after ${maxAttempts} attempts; recover() retries it`);
          return;
        }
      }
      finish(watch.roomId, invocationId);
    } catch (error) {
      if (!closed && watches.get(invocationId) === watch) watchError(invocationId, watch, 'invocation poll', error, 'poll.error');
    } finally {
      watch.busy = false;
    }
  }

  // ---- relay reads ------------------------------------------------------
  async function runningFor(roomId) {
    const [running] = await relay.listRoomInvocations(roomId, { endpointId: self, status: 'running' });
    return running ?? null;
  }

  async function readMessages(roomId, afterSeq = '0') {
    const items = [];
    let cursor = String(afterSeq);
    for (;;) {
      const page = await relay.listRoomMessages(roomId, cursor, PAGE);
      items.push(...page.items);
      if (page.items.length < PAGE || page.next_after_seq == null) return items;
      cursor = String(page.next_after_seq);
    }
  }

  async function listRooms() {
    const body = await relay.request('/v1/rooms');
    return body?.items ?? [];
  }

  async function roomInfo(roomId) {
    try {
      return (await listRooms()).find((room) => room.conversation_id === roomId) ?? null;
    } catch (error) {
      warn(`floor warden: room lookup for ${roomId}: ${error.message}`);
      return null;
    }
  }

  async function failConfirmed(roomId, invocationId, reason, event = 'finish') {
    await relay.failRoomInvocation(roomId, reason, invocationId);
    applyAndCommit(roomId, invocationId, event);
  }

  async function fail(roomId, invocationId, reason) {
    try {
      await relay.failRoomInvocation(roomId, reason, invocationId);
    } catch (error) {
      warn(`floor warden: failRoomInvocation: ${error.message}`);
      // Unconfirmed: keep the record and hand the retries to a watch whose
      // deadline is already due, so the invocation is not left running.
      applyAndCommit(roomId, invocationId, 'handle.fail.retry', { reason, deadlineAt: Date.now() });
      return { outcome: 'failed', reason };
    }
    applyAndCommit(roomId, invocationId, 'handle.fail.ok');
    return { outcome: 'failed', reason };
  }

  // ---- webhook ----------------------------------------------------------
  // ok | reject (4xx other than 408 and 429) | retry (408, 429, 5xx, other, network, timeout)
  async function post(payload) {
    const headers = { 'content-type': 'application/json', [header.name]: header.scheme ? `${header.scheme} ${webhook.key}` : webhook.key };
    let response;
    try {
      response = await fetchImpl(webhook.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(postTimeoutMs), redirect: 'error' });
    } catch (error) {
      return { kind: 'retry', detail: scrub(error?.name === 'TimeoutError' ? 'timeout' : (error?.message ?? 'network error')) };
    }
    try { await response.text?.(); } catch { /* body is not used */ }
    const status = Number(response.status);
    if (status >= 200 && status < 300) return { kind: 'ok', status };
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'reject', status };
    return { kind: 'retry', detail: `HTTP ${status}` };
  }

  // ---- forward ----------------------------------------------------------
  // A throw before the invocation is known propagates, so the daemon leaves
  // the delivery unacked for the next poll. Once it is known, a retryable
  // webhook outcome also throws (same delivery_key on the retry); any other
  // error fails the invocation, or it would stay running with the delivery
  // acked and the bot stuck until Stop.
  async function handle({ envelope }) {
    const roomId = envelope.conversation_id;
    const invocation = await runningFor(roomId);
    if (!invocation || invocation.trigger_message_id !== envelope.message_id) return { outcome: 'skipped' };
    // Already forwarded (a redelivery, or a poll racing a stream trigger): the
    // reply watch owns it now, and a second POST would run the bot twice.
    if (snapshotOf(roomId, invocation.invocation_id).forward) return { outcome: 'skipped' };
    logHop('bridge.invocation_seen', { invocation_id: invocation.invocation_id, room_id: roomId, trigger_message_id: envelope.message_id }, logger);
    try {
      return await forward(envelope, roomId, invocation);
    } catch (error) {
      if (error?.code === RETRY) throw error;
      logger.error?.(scrub(`floor warden bridge: ${error?.message ?? String(error)}`));
      return fail(roomId, invocation.invocation_id, (typeof error?.code === 'string' && error.code) || 'BRIDGE_ERROR');
    }
  }

  async function forward(envelope, roomId, invocation) {
    const invocationId = invocation.invocation_id;
    if (!replyBase) return fail(roomId, invocationId, 'REPLY_URL_UNSET');
    const threadRootId = invocation.thread_root_id;
    const [members, messages, room] = await Promise.all([relay.listRoomMembers(roomId), readMessages(roomId), roomInfo(roomId)]);
    const triggerRow = messages.find((item) => item.message_id === envelope.message_id);
    const triggerSeq = toSeq(triggerRow?.room_seq);
    if (triggerSeq === null) return fail(roomId, invocationId, 'TRIGGER_NOT_FOUND');

    const memberOf = new Map(members.map((member) => [member.endpoint_id, member]));
    const isAgent = (endpointId) => (memberOf.get(endpointId)?.response_mode ?? null) !== null;
    const thread = messages
      .filter((item) => item.envelope?.message_type === 'room.message' && (item.message_id === threadRootId || item.envelope?.body?.thread_root_id === threadRootId))
      .map((item) => ({ room_seq: toSeq(item.room_seq), message_id: item.message_id, sender_endpoint_id: item.envelope?.sender?.endpoint_id ?? null, text: typeof item.envelope?.body?.text === 'string' ? item.envelope.body.text : '' }))
      .filter((item) => item.room_seq !== null);

    // Agent turns used: agent messages in the thread since its latest human message.
    const upTo = thread.filter((item) => item.room_seq <= triggerSeq).sort((a, b) => a.room_seq - b.room_seq);
    let used = 0;
    for (const item of upTo) used = isAgent(item.sender_endpoint_id) ? used + 1 : 0;
    const maxTurns = Number.isInteger(room?.max_agent_turns) ? room.max_agent_turns : DEFAULT_MAX_TURNS;

    const value = roomValue(roomId);
    const watermark = toSeq(value.last_seq_by_thread[threadRootId]);
    const senderId = envelope.sender?.endpoint_id ?? triggerRow.envelope?.sender?.endpoint_id ?? null;
    const target = { bot_id: bot.bot_id, endpoint_id: self, display_name: bot.display_name ?? memberOf.get(self)?.display_name ?? self };
    const payload = buildForwardPayload({
      room: { id: roomId, name: room?.name ?? null },
      bot: target,
      invocation: { id: invocationId, decided_by: invocation.decided_by },
      trigger: {
        message_id: envelope.message_id,
        room_seq: triggerSeq,
        thread_root_id: threadRootId,
        sender: { endpoint_id: senderId, kind: isAgent(senderId) ? 'agent' : 'human', display_name: memberOf.get(senderId)?.display_name ?? triggerRow.display_name ?? senderId },
        text: typeof envelope.body?.text === 'string' ? envelope.body.text : '',
        created_at: envelope.created_at ?? triggerRow.envelope?.created_at ?? null,
      },
      thread,
      watermark,
      replyUrl: `${replyBase}/v1/rooms/${encodeURIComponent(roomId)}/replies`,
      agentTurnsLeft: Math.max(0, maxTurns - used),
      now: new Date(),
    });
    // The builder drops thread entries to fit, but never clips trigger.text.
    if (Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_MAX_BYTES) return fail(roomId, invocationId, 'PAYLOAD_TOO_LARGE');

    const startedAt = Date.now();
    const stored = Number(value.floor_warden.attempts[invocationId] ?? 0);
    let attempt = Math.max(attemptCounts.get(invocationId) ?? 0, Number.isFinite(stored) ? stored : 0);
    let result;
    for (let retry = 0; ; retry += 1) {
      result = await post(payload);
      if (result.kind !== 'retry') break;
      attempt += 1;
      warn(`floor warden: webhook ${origin} unavailable for ${invocationId} (${result.detail}), attempt ${attempt} of ${maxAttempts}`);
      if (attempt >= maxAttempts) return fail(roomId, invocationId, 'FLOOR_WARDEN_UNREACHABLE');
      attemptCounts.set(invocationId, attempt);
      applyAndCommit(roomId, invocationId, 'handle.attempts', { attempts: attempt });
      if (closed || retry >= retryBackoffMs.length) {
        throw Object.assign(new Error(`Floor Warden webhook unavailable (${result.detail}); attempt ${attempt} of ${maxAttempts}`), { code: RETRY });
      }
      await sleep(retryBackoffMs[retry]);
    }
    if (result.kind === 'reject') {
      warn(`floor warden: webhook ${origin} rejected ${invocationId} with HTTP ${result.status}`);
      return fail(roomId, invocationId, 'FLOOR_WARDEN_REJECTED');
    }

    const forwardedAt = Date.now();
    attemptCounts.delete(invocationId);
    applyAndCommit(roomId, invocationId, 'handle.forwarded', {
      forward: { thread_root_id: threadRootId, trigger_message_id: envelope.message_id, trigger_room_seq: triggerSeq, forwarded_at: new Date(forwardedAt).toISOString(), bot: target },
      deadlineAt: forwardedAt + replyTimeoutMs,
      patch: (next) => {
        const previous = toSeq(next.last_seq_by_thread[threadRootId]);
        next.last_seq_by_thread[threadRootId] = String(previous === null ? triggerSeq : Math.max(previous, triggerSeq));
      },
    });
    logger.info?.(`floor warden: forwarded ${invocationId} to ${origin}`);
    logHop('bridge.forwarded', { invocation_id: invocationId, room_id: roomId, trigger_message_id: envelope.message_id, attempts: attempt + 1, forward_ms: forwardedAt - startedAt }, logger);
    return { outcome: 'forwarded' };
  }

  // ---- halt -------------------------------------------------------------
  async function findHaltEvent(roomId, record, invocationId) {
    const items = await readMessages(roomId, String(record.trigger_room_seq ?? 0));
    const events = items.filter((item) => item.envelope?.message_type === 'room.event');
    const halted = events.find((item) => item.envelope.body?.kind === 'room_halted' && Array.isArray(item.envelope.body.endpoint_ids) && item.envelope.body.endpoint_ids.includes(self));
    const stopped = events.find((item) => item.envelope.body?.kind === 'invocation_stopped' && item.envelope.body.invocation_id === invocationId);
    const event = halted ?? stopped;
    if (!event) return { room_seq: null, message_id: null, reason: 'cancelled' };
    return { room_seq: toSeq(event.room_seq), message_id: event.message_id, reason: event.envelope.body.reason ?? 'stopped' };
  }

  // true: sent, rejected for good, or nothing to send. false: retry later.
  async function sendHalt(roomId, invocationId) {
    const fw = roomValue(roomId).floor_warden;
    if (fw.halts[invocationId]) return true;
    const record = fw.forwards[invocationId];
    if (!record) return true;
    const halt = await findHaltEvent(roomId, record, invocationId);
    const payload = buildHaltPayload({ bot: record.bot ?? { bot_id: bot.bot_id, endpoint_id: self, display_name: bot.display_name ?? self }, invocation: { id: invocationId }, trigger: { message_id: record.trigger_message_id }, halt, now: new Date() });
    const result = await post(payload);
    if (result.kind === 'retry') {
      warn(`floor warden: halt frame for ${invocationId} to ${origin} not delivered (${result.detail})`);
      return false;
    }
    if (result.kind === 'reject') warn(`floor warden: webhook ${origin} rejected the halt frame for ${invocationId} with HTTP ${result.status}`);
    else logger.info?.(`floor warden: sent halt frame for ${invocationId} to ${origin}`);
    update(roomId, (next) => {
      // halts only stop a resend; entries older than a day can no longer matter.
      for (const [id, at] of Object.entries(next.floor_warden.halts)) if (Date.now() - Date.parse(at) > HALT_RECORD_TTL_MS) delete next.floor_warden.halts[id];
      next.floor_warden.halts[invocationId] = new Date().toISOString();
      delete next.floor_warden.forwards[invocationId];
      delete next.floor_warden.attempts[invocationId];
    });
    return true;
  }

  // ---- restart ------------------------------------------------------------
  // Fails running invocations past the deadline (measured from the recorded
  // forward, else started_at), re-arms the younger ones, and sends any halt
  // frame a restart lost between the cancel and the poll.
  async function recover() {
    let listed = [];
    try { listed = (await listRooms()).map((room) => room.conversation_id); } catch (error) { warn(`floor warden: recover room list: ${error.message}`); }
    // Rooms the bot left still hold forward records; the store lists them.
    let stored = [];
    try { if (typeof sessions.rooms === 'function') stored = sessions.rooms(); } catch (error) { warn(`floor warden: recover session store room list: ${error?.message ?? String(error)}`); }
    for (const roomId of new Set([...listed, ...stored])) {
      try {
        const fw = roomValue(roomId).floor_warden;
        const running = await relay.listRoomInvocations(roomId, { endpointId: self, status: 'running' });
        const runningIds = new Set();
        for (const invocation of running) {
          const invocationId = invocation.invocation_id;
          runningIds.add(invocationId);
          const startedAt = Date.parse(fw.forwards[invocationId]?.forwarded_at ?? invocation.started_at ?? invocation.created_at ?? '');
          const deadlineAt = Number.isFinite(startedAt) ? startedAt + replyTimeoutMs : Date.now() + replyTimeoutMs;
          if (Date.now() >= deadlineAt) {
            await failConfirmed(roomId, invocationId, 'REPLY_TIMEOUT', 'recover.fail.ok').catch((error) => {
              warn(`floor warden: recover failRoomInvocation for ${invocationId}: ${error.message}`);
              applyAndCommit(roomId, invocationId, 'recover.fail.retry');
            });
          } else arm(roomId, invocationId, deadlineAt);
        }
        const pending = Object.keys(fw.forwards).filter((id) => !runningIds.has(id) && !fw.halts[id]);
        if (!pending.length) continue;
        const all = await relay.listRoomInvocations(roomId, { endpointId: self });
        for (const invocationId of pending) {
          const row = all.find((item) => item.invocation_id === invocationId);
          if (row?.status === 'cancelled') await sendHalt(roomId, invocationId);
          else forget(roomId, invocationId);
        }
      } catch (error) {
        warn(`floor warden: recover ${roomId}: ${error.message}`);
      }
    }
  }

  function close() {
    closed = true;
    for (const invocationId of [...watches.keys()]) disarm(invocationId);
  }

  return { handle, recover, close };
}
