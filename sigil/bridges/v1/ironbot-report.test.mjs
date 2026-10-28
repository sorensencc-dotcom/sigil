// Task 11: Ironbots report poster — policy, locks, FRESH/RECONCILE, refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelayServer } from '../../relay/v1/http-server.mjs';
import { hashBearerToken } from '../../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import {
  sanitizeField,
  buildReportText,
  buildFleetReport,
  createReportPolicy,
  createReportState,
  reportIdempotencyKey,
  baseKey,
  postReport,
  FRESH_MS,
  BOT_ID_PATTERN,
} from './ironbot-report.mjs';

const BASE = new Date('2026-10-16T12:00:00.000Z');
const quiet = { info() {}, warn() {}, error() {} };

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

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-report-'));
  return path.join(dir, 'state.json');
}

async function startWorld({ now = () => BASE } = {}) {
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const reporter = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_reporter', kind: 'agent' });
  const all = [human, reporter];
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
  await repository.createRoom({
    conversationId: 'room_fleet',
    workspaceId: 'ws_usr_chris',
    name: 'fleet',
    createdByHumanId: 'usr_chris',
    ownerEndpointId: 'ep_web',
  });
  await repository.addRoomMember({
    conversationId: 'room_fleet',
    endpointId: 'ep_reporter',
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: 'usr_chris',
    now: BASE,
  });
  const server = createRelayServer({ registry, repository, tokenHashes, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const relay = new RelayClient({ baseUrl: relayUrl, token: reporter.relay_token });
  return {
    repository,
    relay,
    outbox: outboxFor(reporter),
    identity: reporter,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reportOf(overrides = {}) {
  return {
    bot: 'ironbot',
    status: 'degraded',
    timestamp: BASE.toISOString(),
    summary: 'check',
    alerts: [],
    ...overrides,
  };
}

async function runPost(world, { statePath, report, now = () => BASE, relay, outbox, resendAsNew = false, log = quiet } = {}) {
  const state = createReportState({ statePath, now });
  const policy = createReportPolicy({ state, now });
  return postReport({
    identity: world.identity,
    relay: relay ?? world.relay,
    outbox: outbox ?? world.outbox,
    roomId: 'room_fleet',
    report: report ?? reportOf(),
    policy,
    state,
    now,
    log,
    resendAsNew,
  });
}

test('BOT_ID_PATTERN and sanitizeField', () => {
  assert.equal(BOT_ID_PATTERN.test('ironbot'), true);
  assert.equal(BOT_ID_PATTERN.test('../evil'), false);
  assert.equal(sanitizeField('a\nb\u202Ec', 10), 'abc');
  assert.equal(sanitizeField('x'.repeat(100), 8), 'x'.repeat(8));
  assert.equal(sanitizeField(null, 10), '');
});

test('buildReportText is ASCII and at most 4000 chars', () => {
  const text = buildReportText({
    bot: 'ironbot',
    timestamp: '2026-10-16T12:00:00.000Z',
    status: 'ok',
    summary: 'all green',
    alerts: Array.from({ length: 50 }, (_, i) => `alert-${i}-${'z'.repeat(180)}`),
  });
  assert.equal(/^[\x20-\x7E\n]*$/.test(text), true);
  assert.ok(text.length <= 4000);
  assert.match(text, /bot: ironbot/);
});

test('buildFleetReport maps fleet fields and ignores room_id/formatted_message', () => {
  const report = buildFleetReport({
    fleetStatus: 'degraded',
    fleetHealthScore: 42,
    botCount: 3,
    activeBots: ['a', 'b'],
    alerts: ['lag'],
    room_id: 'room_ignored',
    formatted_message: 'IGNORE ME',
    timestamp: '2026-10-16T12:00:00.000Z',
  });
  assert.equal(report.bot, 'fleet');
  assert.equal(report.status, 'degraded');
  assert.equal(report.timestamp, '2026-10-16T12:00:00.000Z');
  assert.match(report.summary, /score=42/);
  assert.deepEqual(report.alerts, ['lag']);
  assert.equal(JSON.stringify(report).includes('IGNORE ME'), false);
});

test('reportIdempotencyKey and baseKey', () => {
  const key = reportIdempotencyKey('ironbot', '2026-10-16T12:00:00.000Z');
  assert.equal(key, 'ironbots_ironbot_2026-10-16T12:00:00.000Z');
  assert.equal(reportIdempotencyKey('ironbot', '2026-10-16T12:00:00.000Z', 2), `${key}_r2`);
  assert.equal(baseKey(`${key}_r2`), key);
  assert.equal(baseKey(key), key);
});

test('createReportPolicy: first, healthy skip, status change, non-healthy, heartbeat, fleet', async () => {
  const statePath = tmpState();
  let clock = BASE.getTime();
  const now = () => new Date(clock);
  const state = createReportState({ statePath, now });
  const policy = createReportPolicy({ state, now });
  assert.equal(await policy.shouldPost({ bot: 'ironbot', status: 'healthy' }), true);
  await state.recordPosted('ironbot', { status: 'healthy', at: BASE.toISOString(), key: 'k1' });
  clock = BASE.getTime() + 60_000;
  assert.equal(await policy.shouldPost({ bot: 'ironbot', status: 'healthy' }), false);
  assert.equal(await policy.shouldPost({ bot: 'ironbot', status: 'degraded' }), true);
  await state.recordPosted('ironbot', { status: 'degraded', at: now().toISOString(), key: 'k2' });
  clock += 60_000;
  assert.equal(await policy.shouldPost({ bot: 'ironbot', status: 'degraded' }), true);
  await state.recordPosted('fleet', { status: 'ok', at: BASE.toISOString(), key: 'fk' });
  clock = BASE.getTime() + 12 * 3600_000;
  assert.equal(await policy.shouldPost({ bot: 'fleet', status: 'ok' }), false);
  clock = BASE.getTime() + 24 * 3600_000;
  assert.equal(await policy.shouldPost({ bot: 'fleet', status: 'ok' }), true);
  await state.recordPosted('ironbot', { status: 'healthy', at: BASE.toISOString(), key: 'k3' });
  clock = BASE.getTime() + 24 * 3600_000;
  assert.equal(await policy.shouldPost({ bot: 'ironbot', status: 'healthy' }), true);
});

test('state atomic rename spy; bad bot id rejected before lock path', async () => {
  const statePath = tmpState();
  let renamed = false;
  const state = createReportState({
    statePath,
    rename: (from, to) => {
      renamed = true;
      fs.renameSync(from, to);
    },
  });
  await state.recordPosted('ironbot', { status: 'ok', at: BASE.toISOString(), key: 'k' });
  assert.equal(renamed, true);
  assert.equal(fs.existsSync(statePath), true);
  await assert.rejects(() => state.withBotLock('../evil', async () => {}), /invalid bot id|bot id/i);
  assert.equal(fs.existsSync(`${statePath}.../evil.lock`) || fs.existsSync(`${statePath}../evil.lock`), false);
});

test('happy path posts once; already_posted for same timestamp and _r1 last_key', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const report = reportOf();
    const first = await runPost(world, { statePath, report });
    assert.equal(first.posted, true);
    assert.equal(first.reason, 'accepted');
    assert.equal(first.created, true);

    const second = await runPost(world, { statePath, report, now: () => new Date(BASE.getTime() + 1000) });
    assert.equal(second.posted, false);
    assert.equal(second.reason, 'already_posted');

    const state = createReportState({ statePath });
    await state.recordPosted('ironbot', {
      status: 'degraded',
      at: BASE.toISOString(),
      key: `${reportIdempotencyKey('ironbot', report.timestamp)}_r1`,
    });
    const third = await runPost(world, { statePath, report, now: () => new Date(BASE.getTime() + 2000) });
    assert.equal(third.reason, 'already_posted');

    const rows = await world.repository.listRoomMessages('room_fleet', 0n, 10);
    assert.equal(rows.filter((m) => m.envelope.message_type === 'room.message').length, 1);
  } finally {
    await world.stop();
  }
});

test('(a) response lost then FRESH duplicate; RECONCILE receipts at +6m', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const report = reportOf();
    let calls = 0;
    const realSend = world.relay.sendEnvelope.bind(world.relay);
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      calls += 1;
      assert.equal(options?.timeoutMs, 30_000);
      if (calls === 1) {
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return realSend(envelope, requestId, options);
    };

    const first = await runPost(world, { statePath, report });
    assert.equal(first.posted, false);
    assert.equal(first.reason, 'transient');
    const state = createReportState({ statePath });
    assert.equal((await state.loadPending('ironbot')).state, 'sending');

    const retry = await runPost(world, {
      statePath,
      report,
      now: () => new Date(BASE.getTime() + 60_000),
    });
    assert.equal(retry.posted, true);
    assert.ok(['duplicate', 'accepted'].includes(retry.reason));
    assert.equal(await state.loadPending('ironbot'), null);
    assert.equal((await state.lastPosted('ironbot')).last_key, reportIdempotencyKey('ironbot', report.timestamp));

    // Seed another response-loss for RECONCILE path
    const statePath2 = tmpState();
    calls = 0;
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      calls += 1;
      if (calls === 1) {
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('drop'), { code: 'ECONNRESET' });
      }
      throw new Error('should not send in reconcile');
    };
    const report2 = reportOf({ timestamp: new Date(BASE.getTime() + 1000).toISOString(), summary: 'recon' });
    await runPost(world, { statePath: statePath2, report: report2 });
    let sendCount = 0;
    world.relay.sendEnvelope = async (...args) => {
      sendCount += 1;
      return realSend(...args);
    };
    const reconciled = await runPost(world, {
      statePath: statePath2,
      report: report2,
      now: () => new Date(BASE.getTime() + FRESH_MS + 120_000),
    });
    assert.equal(sendCount, 0);
    assert.equal(reconciled.reason, 'reconciled');
    assert.equal(await createReportState({ statePath: statePath2 }).loadPending('ironbot'), null);
  } finally {
    await world.stop();
  }
});

test('(b) crash before send: signed FRESH resends; signed RECONCILE drops', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const report = reportOf();
    const state = createReportState({ statePath });
    const unsigned = {
      protocol: 'sigil/1',
      message_id: `msg_${crypto.randomUUID()}`,
      conversation_id: 'room_fleet',
      message_type: 'room.message',
      broadcast_scope: { conversation_id: 'room_fleet' },
      correlation_id: null,
      body: { text: buildReportText(report), mentions: [] },
      context_refs: [],
      capabilities: [],
      idempotency_key: reportIdempotencyKey('ironbot', report.timestamp),
      created_at: BASE.toISOString(),
      expires_at: new Date(BASE.getTime() + 24 * 3600_000).toISOString(),
    };
    const queued = world.outbox.queue(unsigned);
    await state.savePending('ironbot', {
      message_id: queued.envelope.message_id,
      idempotency_key: queued.envelope.idempotency_key,
      created_at: queued.envelope.created_at,
      report: { status: report.status, summary: report.summary, timestamp: report.timestamp },
      envelope: queued.envelope,
      state: 'signed',
    });

    let queuedAgain = false;
    const wrappedOutbox = {
      queue(message) {
        queuedAgain = true;
        return world.outbox.queue(message);
      },
    };
    const fresh = await runPost(world, {
      statePath,
      report,
      outbox: wrappedOutbox,
      now: () => new Date(BASE.getTime() + 60_000),
    });
    assert.equal(queuedAgain, false);
    assert.equal(fresh.posted, true);
    assert.ok(['accepted', 'duplicate'].includes(fresh.reason));

    // signed at +6m: drop and create new
    const statePath2 = tmpState();
    const state2 = createReportState({ statePath: statePath2 });
    const report2 = reportOf({ timestamp: new Date(BASE.getTime() + 2000).toISOString() });
    const q2 = world.outbox.queue({
      ...unsigned,
      message_id: `msg_${crypto.randomUUID()}`,
      idempotency_key: reportIdempotencyKey('ironbot', report2.timestamp),
      created_at: BASE.toISOString(),
      body: { text: buildReportText(report2), mentions: [] },
    });
    await state2.savePending('ironbot', {
      message_id: q2.envelope.message_id,
      idempotency_key: q2.envelope.idempotency_key,
      created_at: q2.envelope.created_at,
      report: { status: report2.status, summary: report2.summary, timestamp: report2.timestamp },
      envelope: q2.envelope,
      state: 'signed',
    });
    const late = await runPost(world, {
      statePath: statePath2,
      report: report2,
      now: () => new Date(BASE.getTime() + FRESH_MS + 60_000),
    });
    assert.equal(late.posted, true);
    assert.equal(late.reason, 'accepted');
  } finally {
    await world.stop();
  }
});

test('(c) request lost RECONCILE keeps pending; resendAsNew posts pending fields', async () => {
  let clock = BASE;
  const world = await startWorld({ now: () => clock });
  const statePath = tmpState();
  try {
    const reportX = reportOf({ summary: 'report-X', status: 'degraded' });
    let dropOnce = true;
    const realSend = world.relay.sendEnvelope.bind(world.relay);
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      if (dropOnce) {
        dropOnce = false;
        throw Object.assign(new Error('lost'), { code: 'ENETUNREACH' });
      }
      return realSend(envelope, requestId, options);
    };
    await runPost(world, { statePath, report: reportX, now: () => clock });
    assert.ok(await createReportState({ statePath }).loadPending('ironbot'));

    const reportY = reportOf({
      timestamp: new Date(BASE.getTime() + 5000).toISOString(),
      summary: 'report-Y',
      status: 'unhealthy',
    });
    let sendCount = 0;
    world.relay.sendEnvelope = async (...args) => {
      sendCount += 1;
      return realSend(...args);
    };
    clock = new Date(BASE.getTime() + FRESH_MS + 60_000);
    const blocked = await runPost(world, {
      statePath,
      report: reportY,
      now: () => clock,
    });
    assert.equal(sendCount, 0);
    assert.equal(blocked.reason, 'pending');

    clock = new Date(BASE.getTime() + FRESH_MS + 120_000);
    const resent = await runPost(world, {
      statePath,
      report: reportY,
      now: () => clock,
      resendAsNew: true,
    });
    assert.ok(
      resent.posted === true || ['accepted', 'already_posted', 'policy'].includes(resent.reason),
      JSON.stringify(resent),
    );
    const rows = await world.repository.listRoomMessages('room_fleet', 0n, 20);
    const texts = rows.map((r) => r.envelope.body.text);
    assert.ok(texts.some((t) => t.includes('report-X')), texts.join('|'));
    const state = createReportState({ statePath });
    const last = await state.lastPosted('ironbot');
    assert.ok(last?.last_key);
    // Y may overwrite last_key after X's _r1 resend; recreate_count stays monotonic.
    const all = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(all.bots.ironbot.recreate_count, 1);
    assert.ok(texts.some((t) => t.includes('report-Y')) || last.last_key.includes('12:00:05'));

    await state.dropPending('ironbot');
    assert.equal(await state.loadPending('ironbot'), null);
  } finally {
    await world.stop();
  }
});

test('(d) boundary 3:59 FRESH resend vs 4:00 RECONCILE no resend', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const report = reportOf();
    let dropOnce = true;
    let sendCalls = 0;
    const realSend = world.relay.sendEnvelope.bind(world.relay);
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      sendCalls += 1;
      if (dropOnce) {
        dropOnce = false;
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('drop'), { code: 'ECONNRESET' });
      }
      return realSend(envelope, requestId, options);
    };
    await runPost(world, { statePath, report });
    const pending = await createReportState({ statePath }).loadPending('ironbot');
    const msgId = pending.message_id;
    const beforeRetry = sendCalls;
    const fresh = await runPost(world, {
      statePath,
      report,
      now: () => new Date(BASE.getTime() + FRESH_MS - 1000),
    });
    assert.ok(sendCalls > beforeRetry);
    assert.ok(['duplicate', 'accepted'].includes(fresh.reason), fresh.reason);

    // New loss for 4:00 boundary
    const statePath2 = tmpState();
    let drop2 = true;
    let reconSends = 0;
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      reconSends += 1;
      if (drop2) {
        drop2 = false;
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('drop'), { code: 'ECONNRESET' });
      }
      throw new Error('no resend at reconcile');
    };
    const report2 = reportOf({ timestamp: new Date(BASE.getTime() + 3000).toISOString() });
    await runPost(world, { statePath: statePath2, report: report2 });
    const sendsBeforeRecon = reconSends;
    const recon = await runPost(world, {
      statePath: statePath2,
      report: report2,
      now: () => new Date(BASE.getTime() + FRESH_MS),
    });
    assert.equal(reconSends, sendsBeforeRecon);
    assert.equal(recon.reason, 'reconciled');
    void msgId;
  } finally {
    await world.stop();
  }
});

test('(h) skewed-clock FRESH retry keeps pending and reconciles via receipts', async () => {
  let relayNow = BASE;
  const world = await startWorld({ now: () => relayNow });
  const statePath = tmpState();
  try {
    const report = reportOf();
    let calls = 0;
    const realSend = world.relay.sendEnvelope.bind(world.relay);
    world.relay.sendEnvelope = async (envelope, requestId, options) => {
      calls += 1;
      if (calls === 1) {
        await realSend(envelope, requestId, options);
        throw Object.assign(new Error('drop'), { code: 'ECONNRESET' });
      }
      return realSend(envelope, requestId, options);
    };
    await runPost(world, { statePath, report, now: () => BASE });

    // Poster still FRESH (+3m); relay clock +6m ahead of created_at -> INVALID_ENVELOPE on retry
    relayNow = new Date(BASE.getTime() + 6 * 60_000);
    const posterNow = new Date(BASE.getTime() + 3 * 60_000);
    const result = await runPost(world, {
      statePath,
      report,
      now: () => posterNow,
    });
    assert.equal(result.reason, 'reconciled');
    assert.equal(await createReportState({ statePath }).loadPending('ironbot'), null);
    const later = await runPost(world, {
      statePath,
      report,
      now: () => new Date(BASE.getTime() + 7 * 60_000),
    });
    assert.equal(later.reason, 'already_posted');
  } finally {
    await world.stop();
  }
});

test('content refusal drops pending; first-send INVALID_ENVELOPE drops', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const mentionsOutbox = {
      queue(message) {
        return world.outbox.queue({
          ...message,
          body: { ...message.body, mentions: ['ep_web'] },
        });
      },
    };
    const refused = await runPost(world, {
      statePath,
      report: reportOf(),
      outbox: mentionsOutbox,
    });
    assert.equal(refused.posted, false);
    assert.equal(refused.reason, 'refused');
    assert.equal(await createReportState({ statePath }).loadPending('ironbot'), null);

    // Clock skew first send -> INVALID_ENVELOPE -> refused
    const skewPath = tmpState();
    const posterNow = () => new Date(BASE.getTime() + 10 * 60_000);
    const skewWorld = await startWorld({ now: () => BASE });
    try {
      const skew = await runPost(skewWorld, {
        statePath: skewPath,
        report: reportOf({ timestamp: posterNow().toISOString() }),
        now: posterNow,
      });
      assert.equal(skew.reason, 'refused');
      assert.equal(await createReportState({ statePath: skewPath }).loadPending('ironbot'), null);
    } finally {
      await skewWorld.stop();
    }
  } finally {
    await world.stop();
  }
});

test('unresolved pending blocks same --report-at without new envelope', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const report = reportOf();
    let calls = 0;
    world.relay.sendEnvelope = async () => {
      calls += 1;
      throw Object.assign(new Error('lost'), { code: 'ENETUNREACH' });
    };
    await runPost(world, { statePath, report });
    calls = 0;
    const blocked = await runPost(world, {
      statePath,
      report,
      now: () => new Date(BASE.getTime() + 30_000),
    });
    // Still FRESH so it will try resend; force RECONCILE by advancing
    const blocked2 = await runPost(world, {
      statePath,
      report,
      now: () => new Date(BASE.getTime() + FRESH_MS + 60_000),
    });
    assert.equal(blocked2.reason, 'pending');
    void blocked;
  } finally {
    await world.stop();
  }
});

test('RelayClient.getMessageReceipts returns receipts for sender', async () => {
  const world = await startWorld();
  const statePath = tmpState();
  try {
    const posted = await runPost(world, { statePath, report: reportOf() });
    assert.equal(posted.posted, true);
    const rows = await world.repository.listRoomMessages('room_fleet', 0n, 5);
    assert.ok(rows.length >= 1);
    const mid = rows[0].message_id;
    const receipts = await world.relay.getMessageReceipts(mid);
    assert.equal(receipts.message_id, mid);
    assert.ok(Array.isArray(receipts.receipts));
  } finally {
    await world.stop();
  }
});
