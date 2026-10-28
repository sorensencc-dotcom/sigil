// sigil/bridges/v1/rooms-bridges-exit.test.mjs
// Phase 5 exit: resume bridge, replay bridge (capabilities.resume = false),
// lost-session recovery + two-thread cursor replacement, report_only isolation,
// and response-loss FRESH/RECONCILE retries in one room shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../../relay/v1/http-server.mjs';
import { hashBearerToken } from '../../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createAgentDaemon } from '../../cli/agent-daemon.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { createRoomBridge } from './room-bridge.mjs';
import { createSessionStore } from './session-store.mjs';
import {
  createReportPolicy,
  createReportState,
  reportIdempotencyKey,
  postReport,
  FRESH_MS,
} from './ironbot-report.mjs';

const ROOM = 'room_bridges_exit';
const BASE = new Date('2026-10-16T12:00:00.000Z');
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function outboxFor(identity) {
  return new LocalOutbox({
    privateKey: identityKeys(identity).privateKey,
    endpoint: {
      owner_id: identity.owner_id,
      endpoint_id: identity.endpoint_id,
      key_id: identity.key_id,
      kind: identity.kind,
    },
  });
}

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function startWorld({ resumeRun, replayRun, now } = {}) {
  let clockOverride = now ?? null;
  const currentNow = () => (clockOverride ? clockOverride() : new Date());

  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const resumeAgent = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_test_resume', kind: 'agent' });
  const replayAgent = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_test_replay', kind: 'agent' });
  const reporter = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_test_reporter', kind: 'agent' });
  const router = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_router', kind: 'agent' });
  const all = [human, resumeAgent, replayAgent, reporter, router];

  const registry = new Map(all.map((id) => [
    id.endpoint_id,
    {
      owner_id: id.owner_id,
      endpoint_id: id.endpoint_id,
      key_id: id.key_id,
      kind: id.kind,
      status: 'active',
      public_key: crypto.createPublicKey(id.public_key_pem),
    },
  ]));
  const tokenHashes = new Map(all.map((id) => [hashBearerToken(id.relay_token), id.endpoint_id]));
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, tokenHashes, now: currentNow });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;

  await repository.createRoom({
    conversationId: ROOM,
    workspaceId: 'ws_usr_chris',
    name: 'bridges exit',
    createdByHumanId: 'usr_chris',
    ownerEndpointId: 'ep_web',
    now: currentNow(),
  });
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: 'ep_test_resume',
    role: 'member',
    responseMode: 'joins',
    addedByHumanId: 'usr_chris',
    now: currentNow(),
  });
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: 'ep_test_replay',
    role: 'member',
    responseMode: 'joins',
    addedByHumanId: 'usr_chris',
    now: currentNow(),
  });
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: 'ep_test_reporter',
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: 'usr_chris',
    now: currentNow(),
  });
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: 'ep_router',
    role: 'member',
    responseMode: 'router',
    addedByHumanId: 'usr_chris',
    now: currentNow(),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bridges-exit-'));
  const resumeCalls = [];
  const replayCalls = [];
  let resumeSessionSeq = 1;

  const defaultResumeRun = async (input) => {
    const sessionId = input.sessionId ?? `sess_resume_${resumeSessionSeq++}`;
    return { text: `resume reply (${sessionId})`, sessionId };
  };
  const defaultReplayRun = async () => ({
    text: 'replay reply',
    sessionId: 'sess_replay_ignored',
  });

  const resumeCli = {
    name: 'test-resume',
    capabilities: { resume: true },
    async run(input) {
      resumeCalls.push({ prompt: input.prompt, sessionId: input.sessionId });
      return (resumeRun ?? defaultResumeRun)(input, resumeCalls);
    },
  };
  const replayCli = {
    name: 'test-replay',
    capabilities: { resume: false },
    async run(input) {
      replayCalls.push({ prompt: input.prompt, sessionId: input.sessionId });
      return (replayRun ?? defaultReplayRun)(input, replayCalls);
    },
  };

  const resumeSessions = createSessionStore(path.join(dir, 'ep_test_resume.json'));
  const replaySessions = createSessionStore(path.join(dir, 'ep_test_replay.json'));

  const daemons = [
    [resumeAgent, resumeCli, resumeSessions],
    [replayAgent, replayCli, replaySessions],
  ].map(([identity, cli, sessions]) => {
    const bridge = createRoomBridge({
      identity,
      relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }),
      outbox: outboxFor(identity),
      cli,
      sessions,
      pollIntervalMs: 50,
      logger: quiet,
    });
    const daemon = createAgentDaemon({
      identity,
      relayUrl,
      onRoomMessage: bridge.handle,
      pollIntervalMs: 50,
      logger: quiet,
    });
    daemon.start();
    return daemon;
  });

  const humanClient = new RelayClient({ baseUrl: relayUrl, token: human.relay_token });
  const humanOutbox = outboxFor(human);
  const reporterRelay = new RelayClient({ baseUrl: relayUrl, token: reporter.relay_token });
  const reporterOutbox = outboxFor(reporter);

  async function say(text, mentions = [], threadRootId) {
    const ts = currentNow();
    const queued = humanOutbox.queue({
      protocol: 'sigil/1',
      message_id: `msg_${crypto.randomUUID()}`,
      conversation_id: ROOM,
      message_type: 'room.message',
      broadcast_scope: { conversation_id: ROOM },
      correlation_id: null,
      body: { text, mentions, ...(threadRootId ? { thread_root_id: threadRootId } : {}) },
      context_refs: [],
      capabilities: [],
      idempotency_key: `idem_${crypto.randomUUID()}`,
      created_at: ts.toISOString(),
      expires_at: new Date(ts.getTime() + 3600_000).toISOString(),
    });
    await humanClient.sendEnvelope(queued.envelope);
    return queued.envelope.message_id;
  }

  function setNow(fn) {
    clockOverride = fn;
  }

  async function stop() {
    for (const daemon of daemons) daemon.stop();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return {
    dir,
    repository,
    say,
    setNow,
    stop,
    resumeCalls,
    replayCalls,
    resumeSessions,
    replaySessions,
    reporter,
    reporterRelay,
    reporterOutbox,
  };
}

test('mentions of resume and replay bridges yield signed replies; replay second turn carries full thread window and stores no session', { timeout: 60_000 }, async () => {
  const world = await startWorld();
  try {
    const resumeRoot = await world.say('hello @ep_test_resume', ['ep_test_resume']);
    const resumeReply = await waitFor(async () => {
      const messages = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return messages.find((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === resumeRoot);
    });
    assert.equal(resumeReply.envelope.message_type, 'room.message');
    assert.equal(resumeReply.envelope.body.thread_root_id, resumeRoot);
    assert.ok(resumeReply.envelope.signature?.value);
    assert.equal(world.resumeSessions.get(ROOM)?.session_id, 'sess_resume_1');

    const replayRoot = await world.say('first turn for @ep_test_replay', ['ep_test_replay']);
    const replayReply1 = await waitFor(async () => {
      const messages = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return messages.find((m) => m.envelope.sender.endpoint_id === 'ep_test_replay' && m.envelope.body.thread_root_id === replayRoot);
    });
    assert.equal(replayReply1.envelope.message_type, 'room.message');
    assert.equal(replayReply1.envelope.body.thread_root_id, replayRoot);
    assert.ok(replayReply1.envelope.signature?.value);
    assert.equal(world.replayCalls.length, 1);
    assert.equal(world.replayCalls[0].sessionId, null);
    assert.equal(world.replaySessions.get(ROOM), null);

    // Second turn in the same thread for the replay bridge:
    await world.say('second turn for @ep_test_replay', ['ep_test_replay'], replayRoot);
    await waitFor(async () => {
      const messages = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return messages.filter((m) => m.envelope.sender.endpoint_id === 'ep_test_replay' && m.envelope.body.thread_root_id === replayRoot).length === 2;
    });
    assert.equal(world.replayCalls.length, 2);
    assert.equal(world.replayCalls[1].sessionId, null);
    // Replay window starts from afterSeq '0', so earlier messages in the thread appear in the second turn prompt:
    assert.match(world.replayCalls[1].prompt, /first turn for @ep_test_replay/);
    assert.match(world.replayCalls[1].prompt, /replay reply/);
    assert.match(world.replayCalls[1].prompt, /second turn for @ep_test_replay/);
    assert.equal(world.replaySessions.get(ROOM), null);
  } finally {
    await world.stop();
  }
});

test('lost session on resume bridge retries once with sessionId null and replacements drop other thread cursors', { timeout: 60_000 }, async () => {
  let failNextWithSessionLost = false;
  let nextSessionId = 'sess_initial';

  const world = await startWorld({
    resumeRun: async (input) => {
      if (failNextWithSessionLost && input.sessionId !== null) {
        failNextWithSessionLost = false;
        throw Object.assign(new Error('No session, task, or name matched'), { code: 'CLI_SESSION_LOST' });
      }
      return { text: `answered (${nextSessionId})`, sessionId: nextSessionId };
    },
  });

  try {
    // Visit thread A then thread B under sess_initial
    const threadA = await world.say('thread A root @ep_test_resume', ['ep_test_resume']);
    await waitFor(async () => {
      const msgs = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return msgs.some((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === threadA);
    });

    const threadB = await world.say('thread B root @ep_test_resume', ['ep_test_resume']);
    await waitFor(async () => {
      const msgs = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return msgs.some((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === threadB);
    });

    const storedBoth = world.resumeSessions.get(ROOM);
    assert.equal(storedBoth.session_id, 'sess_initial');
    assert.deepEqual(Object.keys(storedBoth.last_seq_by_thread).sort(), [threadA, threadB].sort());

    // Next turn in thread A throws CLI_SESSION_LOST once, then succeeds with a new session id
    failNextWithSessionLost = true;
    nextSessionId = 'sess_replaced';
    const callsBeforeLost = world.resumeCalls.length;

    await world.say('thread A follow-up @ep_test_resume', ['ep_test_resume'], threadA);
    await waitFor(async () => {
      const msgs = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return msgs.filter((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === threadA).length === 2;
    });

    // Two CLI calls for this turn: first with sess_initial, retry with null
    assert.equal(world.resumeCalls.length, callsBeforeLost + 2);
    assert.equal(world.resumeCalls[callsBeforeLost].sessionId, 'sess_initial');
    assert.equal(world.resumeCalls[callsBeforeLost + 1].sessionId, null);
    assert.match(world.resumeCalls[callsBeforeLost + 1].prompt, /thread A root @ep_test_resume/);
    assert.match(world.resumeCalls[callsBeforeLost + 1].prompt, /thread A follow-up @ep_test_resume/);

    // Session record replaced: new session_id stored, and ONLY thread A's cursor remains (thread B dropped)
    const afterReplace = world.resumeSessions.get(ROOM);
    assert.equal(afterReplace.session_id, 'sess_replaced');
    assert.deepEqual(Object.keys(afterReplace.last_seq_by_thread), [threadA]);
    assert.equal(afterReplace.last_seq_by_thread[threadB], undefined);

    // Next turn in thread B starts from cursor 0 (full replay window for thread B)
    await world.say('thread B follow-up @ep_test_resume', ['ep_test_resume'], threadB);
    await waitFor(async () => {
      const msgs = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return msgs.filter((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === threadB).length === 2;
    });

    const lastCall = world.resumeCalls.at(-1);
    assert.equal(lastCall.sessionId, 'sess_replaced');
    assert.match(lastCall.prompt, /thread B root @ep_test_resume/);
    assert.match(lastCall.prompt, /answered \(sess_initial\)/);
    assert.match(lastCall.prompt, /thread B follow-up @ep_test_resume/);
  } finally {
    await world.stop();
  }
});

test('report_only post via postReport creates no invocation, preserves hop budget and router inbox, ignores @mention of reporter, and marks report_post true', { timeout: 60_000 }, async () => {
  const world = await startWorld();
  try {
    // Establish an active thread with a reserved agent turn to check hop budget preservation
    const rootId = await world.say('budget check @ep_test_resume', ['ep_test_resume']);
    await waitFor(async () => {
      const msgs = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return msgs.some((m) => m.envelope.sender.endpoint_id === 'ep_test_resume' && m.envelope.body.thread_root_id === rootId);
    });
    assert.equal(world.repository._debugGetAgentTurns(ROOM, rootId), 1);

    // Switch relay and poster clock to fixed BASE for deterministic report posting
    world.setNow(() => BASE);
    const invocationsBefore = await world.repository.listRoomInvocations(ROOM);
    const routerInboxBefore = await world.repository.listInbox('ep_router');

    const statePath = path.join(world.dir, 'report-state.json');
    const state = createReportState({ statePath, now: () => BASE });
    const policy = createReportPolicy({ state, now: () => BASE });
    const report = {
      bot: 'ironbot',
      status: 'degraded',
      timestamp: BASE.toISOString(),
      summary: 'all checks nominal',
      alerts: ['disk 80%'],
    };

    const result = await postReport({
      identity: world.reporter,
      relay: world.reporterRelay,
      outbox: world.reporterOutbox,
      roomId: ROOM,
      report,
      policy,
      state,
      now: () => BASE,
      log: quiet,
    });
    assert.equal(result.posted, true);
    assert.equal(result.reason, 'accepted');

    // No new room_invocations for ep_test_reporter (or anyone else)
    const invocationsAfter = await world.repository.listRoomInvocations(ROOM);
    assert.equal(invocationsAfter.length, invocationsBefore.length);
    assert.equal(invocationsAfter.filter((r) => r.endpoint_id === 'ep_test_reporter').length, 0);

    // Hop budget unchanged
    assert.equal(world.repository._debugGetAgentTurns(ROOM, rootId), 1);

    // Router inbox length unchanged
    const routerInboxAfter = await world.repository.listInbox('ep_router');
    assert.equal(routerInboxAfter.length, routerInboxBefore.length);

    // Stored report row has report_post === true (listRoomMessages omits the flag; use lookup)
    const reportRows = (await world.repository.listRoomMessages(ROOM, 0n, 100))
      .filter((m) => m.envelope.sender.endpoint_id === 'ep_test_reporter');
    assert.equal(reportRows.length, 1);
    const stored = await world.repository.lookupRoomMessage(ROOM, reportRows[0].message_id);
    assert.ok(stored);
    assert.equal(stored.report_post, true);
    assert.equal(stored.envelope.sender.endpoint_id, 'ep_test_reporter');

    // @mention of ep_test_reporter creates no invocation for it
    await world.say('hey @ep_test_reporter please respond', ['ep_test_reporter']);
    const invocationsAfterMention = await world.repository.listRoomInvocations(ROOM);
    assert.equal(invocationsAfterMention.filter((r) => r.endpoint_id === 'ep_test_reporter').length, 0);
  } finally {
    await world.stop();
  }
});

test('response-loss retry for reporter: FRESH resends stored envelope once; +6m RECONCILE uses receipts with zero sends and no INVALID_ENVELOPE', { timeout: 60_000 }, async () => {
  let clock = BASE;
  const world = await startWorld({ now: () => clock });
  try {
    const realSend = world.reporterRelay.sendEnvelope.bind(world.reporterRelay);

    // Case 1: response lost after relay accepted, retried inside FRESH window (< 4m)
    const statePath1 = path.join(world.dir, 'state-fresh.json');
    const report1 = {
      bot: 'ironbot',
      status: 'degraded',
      timestamp: BASE.toISOString(),
      summary: 'fresh retry case',
      alerts: [],
    };

    let freshCalls = 0;
    world.reporterRelay.sendEnvelope = async (envelope, requestId, options) => {
      freshCalls += 1;
      if (freshCalls === 1) {
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return realSend(envelope, requestId, options);
    };

    const runReport = async (statePath, report, nowFn) => {
      const state = createReportState({ statePath, now: nowFn });
      const policy = createReportPolicy({ state, now: nowFn });
      return postReport({
        identity: world.reporter,
        relay: world.reporterRelay,
        outbox: world.reporterOutbox,
        roomId: ROOM,
        report,
        policy,
        state,
        now: nowFn,
        log: quiet,
      });
    };

    const firstAttempt = await runReport(statePath1, report1, () => clock);
    assert.equal(firstAttempt.posted, false);
    assert.equal(firstAttempt.reason, 'transient');
    const state1 = createReportState({ statePath: statePath1 });
    const pending1 = await state1.loadPending('ironbot');
    assert.ok(pending1);
    assert.equal(pending1.state, 'sending');

    // Retry at +1 minute (< 4m FRESH window): resends stored envelope
    clock = new Date(BASE.getTime() + 60_000);
    const freshRetry = await runReport(statePath1, report1, () => clock);
    assert.equal(freshCalls, 2);
    assert.equal(freshRetry.posted, true);
    assert.ok(['duplicate', 'accepted'].includes(freshRetry.reason));
    assert.equal(await state1.loadPending('ironbot'), null);
    assert.equal((await state1.lastPosted('ironbot')).last_key, reportIdempotencyKey('ironbot', report1.timestamp));

    const messagesAfterFresh = await world.repository.listRoomMessages(ROOM, 0n, 100);
    const report1Rows = messagesAfterFresh.filter((m) => m.message_id === pending1.message_id);
    assert.equal(report1Rows.length, 1);
    assert.equal((await world.repository.lookupRoomMessage(ROOM, pending1.message_id)).report_post, true);

    // Case 2: response lost after relay accepted, retried at +6 minutes (RECONCILE via receipts)
    clock = BASE;
    const statePath2 = path.join(world.dir, 'state-reconcile.json');
    const report2 = {
      bot: 'ironbot',
      status: 'degraded',
      timestamp: new Date(BASE.getTime() + 1000).toISOString(),
      summary: 'reconcile receipts case',
      alerts: [],
    };

    let lossCalls = 0;
    world.reporterRelay.sendEnvelope = async (envelope, requestId, options) => {
      lossCalls += 1;
      if (lossCalls === 1) {
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      throw new Error('must not resend during RECONCILE');
    };

    const secondAttempt = await runReport(statePath2, report2, () => clock);
    assert.equal(secondAttempt.posted, false);
    assert.equal(secondAttempt.reason, 'transient');
    const state2 = createReportState({ statePath: statePath2 });
    const pending2 = await state2.loadPending('ironbot');
    assert.ok(pending2);
    assert.equal(pending2.state, 'sending');

    let sendCount = 0;
    world.reporterRelay.sendEnvelope = async (...args) => {
      sendCount += 1;
      return realSend(...args);
    };

    // Advance to BASE + FRESH_MS + 120_000 (+6 minutes)
    clock = new Date(BASE.getTime() + FRESH_MS + 120_000);
    const reconciled = await runReport(statePath2, report2, () => clock);
    assert.equal(sendCount, 0);
    assert.equal(reconciled.posted, true);
    assert.equal(reconciled.reason, 'reconciled');
    assert.equal(await state2.loadPending('ironbot'), null);
    assert.equal((await state2.lastPosted('ironbot')).last_key, reportIdempotencyKey('ironbot', report2.timestamp));

    const messagesAfterReconcile = await world.repository.listRoomMessages(ROOM, 0n, 100);
    const report2Rows = messagesAfterReconcile.filter((m) => m.message_id === pending2.message_id);
    assert.equal(report2Rows.length, 1);
    assert.equal((await world.repository.lookupRoomMessage(ROOM, pending2.message_id)).report_post, true);
    assert.equal(messagesAfterReconcile.filter((m) => m.envelope.sender.endpoint_id === 'ep_test_reporter').length, 2);
  } finally {
    await world.stop();
  }
});
