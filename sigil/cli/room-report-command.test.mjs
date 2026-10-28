// Phase 5 Task 12: `sigil room report` CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from './memory-repository.mjs';
import { createIdentity, saveIdentity, identityKeys } from './identity.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import {
  createReportState,
  reportIdempotencyKey,
  FRESH_MS,
} from '../bridges/v1/ironbot-report.mjs';
import { runRoomReport, defaultStatePath, ROOM_REPORT_EXIT } from './room-report-command.mjs';

const BASE = new Date('2026-10-16T12:00:00.000Z');
const ROOM = 'room_test_1';
const EP = 'ep_test_reporter';

function quietLog() {
  const lines = [];
  return {
    lines,
    info: (...a) => lines.push(['info', ...a].join(' ')),
    warn: (...a) => lines.push(['warn', ...a].join(' ')),
    error: (...a) => lines.push(['error', ...a].join(' ')),
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-room-report-'));
}

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

async function startWorld({ now = () => BASE } = {}) {
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const reporter = createIdentity({ ownerId: 'usr_chris', endpointId: EP, kind: 'agent' });
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
    conversationId: ROOM,
    workspaceId: 'ws_usr_chris',
    name: 'fleet',
    createdByHumanId: 'usr_chris',
    ownerEndpointId: 'ep_web',
  });
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: EP,
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: 'usr_chris',
    now: BASE,
  });
  const server = createRelayServer({ registry, repository, tokenHashes, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = tmpDir();
  const identityPath = path.join(dir, 'identity.json');
  saveIdentity(identityPath, reporter);
  const statePath = path.join(dir, 'state.json');
  return {
    repository,
    relayUrl,
    identityPath,
    statePath,
    identity: reporter,
    dir,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function baseArgv(world, extra = []) {
  return [
    '--identity', world.identityPath,
    '--relay-url', world.relayUrl,
    '--room', ROOM,
    '--state', world.statePath,
    ...extra,
  ];
}

async function run(world, extra, deps = {}) {
  const log = quietLog();
  const code = await runRoomReport(baseArgv(world, extra), { now: () => BASE, log, ...deps });
  return { code, log };
}

test('defaultStatePath uses endpoint id under .sigil', () => {
  assert.equal(defaultStatePath('ep_x'), path.join('.sigil', 'report-state-ep_x.json'));
});

test('single report flags post once and exit 0; --alert repeats', async () => {
  const world = await startWorld();
  try {
    const { code, log } = await run(world, [
      '--bot', 'ironbot',
      '--status', 'degraded',
      '--summary', 'check',
      '--alert', 'a1',
      '--alert', 'a2',
      '--report-at', BASE.toISOString(),
    ]);
    assert.equal(code, 0);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    const msgs = rows.filter((m) => m.envelope.message_type === 'room.message');
    assert.equal(msgs.length, 1);
    const text = msgs[0].envelope.body.text;
    assert.match(text, /alert: a1/);
    assert.match(text, /alert: a2/);
    assert.match(log.lines.join('\n'), /report_posted/);
  } finally {
    await world.stop();
  }
});

test('missing --room exits 1 naming the flag', async () => {
  const world = await startWorld();
  try {
    const log = quietLog();
    await assert.rejects(
      () => runRoomReport([
        '--identity', world.identityPath,
        '--relay-url', world.relayUrl,
        '--bot', 'ironbot',
        '--status', 'degraded',
        '--summary', 'x',
        '--state', world.statePath,
      ], { log, now: () => BASE }),
      (err) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /--room/);
        return true;
      },
    );
  } finally {
    await world.stop();
  }
});

test('--from-report posts fleet summary from structured fields; ignores formatted_message and JSON room_id', async () => {
  const world = await startWorld();
  try {
    const reportPath = path.join(world.dir, 'ironbots_daily_report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      room_id: 'sigil-fleet-observability',
      fleetStatus: 'healthy',
      fleetHealthScore: 97,
      botCount: 3,
      activeBots: ['a', 'b', 'c'],
      alerts: ['disk'],
      timestamp: BASE.toISOString(),
      formatted_message: 'SHOULD_NEVER_APPEAR_IN_POST',
    }));
    const { code } = await run(world, ['--from-report', reportPath]);
    assert.equal(code, 0);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    const text = rows[0].envelope.body.text;
    assert.doesNotMatch(text, /SHOULD_NEVER_APPEAR_IN_POST/);
    assert.match(text, /bot: fleet/);
    assert.match(text, /status: healthy/);
    assert.match(text, /fleet score=97/);
    assert.match(text, /alert: disk/);
    assert.equal(rows[0].envelope.broadcast_scope?.conversation_id ?? rows[0].envelope.conversation_id, ROOM);
  } finally {
    await world.stop();
  }
});

test('already_posted for same --report-at; also when last_key has _r1 suffix', async () => {
  const world = await startWorld();
  try {
    const ts = BASE.toISOString();
    const flags = ['--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', ts];
    assert.equal((await run(world, flags)).code, 0);
    const second = await run(world, flags, { now: () => new Date(BASE.getTime() + 1000) });
    assert.equal(second.code, 0);
    assert.match(second.log.lines.join('\n'), /already_posted/);

    const state = createReportState({ statePath: world.statePath });
    await state.recordPosted('ironbot', {
      status: 'degraded',
      at: ts,
      key: `${reportIdempotencyKey('ironbot', ts)}_r1`,
    });
    const third = await run(world, flags, { now: () => new Date(BASE.getTime() + 2000) });
    assert.equal(third.code, 0);
    assert.match(third.log.lines.join('\n'), /already_posted/);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    assert.equal(rows.filter((m) => m.envelope.message_type === 'room.message').length, 1);
  } finally {
    await world.stop();
  }
});

test('healthy status inside 24h exits 0 by policy', async () => {
  const world = await startWorld();
  try {
    const flags1 = ['--bot', 'ironbot', '--status', 'healthy', '--summary', 'ok', '--report-at', BASE.toISOString()];
    assert.equal((await run(world, flags1)).code, 0);
    const later = await run(world, [
      '--bot', 'ironbot', '--status', 'healthy', '--summary', 'still',
      '--report-at', new Date(BASE.getTime() + 3600_000).toISOString(),
    ], { now: () => new Date(BASE.getTime() + 3600_000) });
    assert.equal(later.code, 0);
    assert.match(later.log.lines.join('\n'), /report_skipped_by_policy|already_posted/);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    assert.equal(rows.filter((m) => m.envelope.message_type === 'room.message').length, 1);
  } finally {
    await world.stop();
  }
});

test('503 exits 3 keeping pending; FRESH retry inside 4m against healthy exits 0', async () => {
  const world = await startWorld();
  try {
    let calls = 0;
    const realClient = RelayClient;
    class FlakyClient extends realClient {
      async sendEnvelope(envelope, requestId, options) {
        calls += 1;
        if (calls === 1) {
          const err = new Error('unavailable');
          err.status = 503;
          err.code = 'UNAVAILABLE';
          throw err;
        }
        return super.sendEnvelope(envelope, requestId, options);
      }
    }
    const ts = BASE.toISOString();
    const flags = ['--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', ts];
    const first = await run(world, flags, { RelayClient: FlakyClient });
    assert.equal(first.code, 3);
    const pending = await createReportState({ statePath: world.statePath }).loadPending('ironbot');
    assert.ok(pending);

    const second = await run(world, flags, {
      RelayClient: FlakyClient,
      now: () => new Date(BASE.getTime() + 60_000),
    });
    assert.equal(second.code, 0);
    assert.equal(await createReportState({ statePath: world.statePath }).loadPending('ironbot'), null);
  } finally {
    await world.stop();
  }
});

test('response-loss then FRESH resend with fresh LocalOutbox exits 0; +6m reconciles', async () => {
  const world = await startWorld();
  try {
    const ts = BASE.toISOString();
    const flags = ['--bot', 'ironbot', '--status', 'degraded', '--summary', 'loss', '--report-at', ts];
    let calls = 0;
    class DropOnce extends RelayClient {
      async sendEnvelope(envelope, requestId, options) {
        calls += 1;
        const result = await super.sendEnvelope(envelope, requestId, options);
        if (calls === 1) {
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        return result;
      }
    }
    assert.equal((await run(world, flags, { RelayClient: DropOnce })).code, 3);

    // Fresh deps (new LocalOutbox via real constructor), inside 4m
    calls = 0;
    class Counting extends RelayClient {
      async sendEnvelope(envelope, requestId, options) {
        calls += 1;
        return super.sendEnvelope(envelope, requestId, options);
      }
    }
    const retry = await run(world, flags, {
      RelayClient: Counting,
      now: () => new Date(BASE.getTime() + 60_000),
    });
    assert.equal(retry.code, 0);
    assert.ok(calls >= 1);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    assert.equal(rows.filter((m) => m.envelope.message_type === 'room.message').length, 1);

    // Seed another loss for reconcile at +6m on a separate state file
    const statePath2 = path.join(world.dir, 'state2.json');
    const ts2 = new Date(BASE.getTime() + 1000).toISOString();
    let dropCalls = 0;
    class DropOnce2 extends RelayClient {
      async sendEnvelope(envelope, requestId, options) {
        dropCalls += 1;
        const result = await super.sendEnvelope(envelope, requestId, options);
        if (dropCalls === 1) throw Object.assign(new Error('drop'), { code: 'ECONNRESET' });
        return result;
      }
    }
    const lossArgv = [
      '--identity', world.identityPath,
      '--relay-url', world.relayUrl,
      '--room', ROOM,
      '--state', statePath2,
      '--bot', 'ironbot',
      '--status', 'degraded',
      '--summary', 'recon',
      '--report-at', ts2,
    ];
    assert.equal(await runRoomReport(lossArgv, {
      RelayClient: DropOnce2,
      now: () => new Date(BASE.getTime() + 1000),
      log: quietLog(),
    }), 3);

    let sendCount = 0;
    class NoSend extends RelayClient {
      async sendEnvelope(...args) {
        sendCount += 1;
        return super.sendEnvelope(...args);
      }
    }
    const reconciled = await runRoomReport(lossArgv, {
      RelayClient: NoSend,
      now: () => new Date(BASE.getTime() + FRESH_MS + 120_000),
      log: quietLog(),
    });
    assert.equal(reconciled, 0);
    assert.equal(sendCount, 0);
  } finally {
    await world.stop();
  }
});

test('unresolved pending at +5/+6/+7 exits 3; same --report-at skips; --resend-as-new posts _r1', async () => {
  let clock = BASE;
  const world = await startWorld({ now: () => clock });
  try {
    const ts = BASE.toISOString();
    const flags = ['--bot', 'ironbot', '--status', 'degraded', '--summary', 'X', '--report-at', ts];
    // Force pending sending without accept: send throws before relay sees it
    class NeverSend extends RelayClient {
      async sendEnvelope() {
        throw Object.assign(new Error('network'), { code: 'ECONNREFUSED' });
      }
    }
    // Sign+mark sending by running once (pending created then send fails)
    assert.equal((await run(world, flags, { RelayClient: NeverSend, now: () => clock })).code, 3);
    const pending = await createReportState({ statePath: world.statePath }).loadPending('ironbot');
    assert.equal(pending.state, 'sending');

    for (const offset of [5, 6, 7].map((m) => m * 60_000)) {
      clock = new Date(BASE.getTime() + offset);
      const r = await run(world, flags, {
        RelayClient: NeverSend,
        now: () => clock,
      });
      assert.equal(r.code, 3);
      assert.match(r.log.lines.join('\n'), /report_pending_unresolved|report_transient|lock_timeout/);
    }

    // --resend-as-new against a healthy relay (shared clock so created_at is valid)
    clock = new Date(BASE.getTime() + 8 * 60_000);
    const resent = await run(world, [...flags, '--resend-as-new'], {
      now: () => clock,
    });
    assert.equal(resent.code, 0);
    const last = await createReportState({ statePath: world.statePath }).lastPosted('ironbot');
    assert.match(last.last_key, /_r1$/);
  } finally {
    await world.stop();
  }
});

test('lock_timeout exits 3 with diagnostics; --break-lock then report proceeds', async () => {
  const world = await startWorld();
  try {
    const botLock = `${world.statePath}.ironbot.lock`;
    fs.writeFileSync(botLock, JSON.stringify({
      pid: 999999, host: 'test', token: 'dead', acquired_at: BASE.toISOString(),
    }));
    const blocked = await run(world, [
      '--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', BASE.toISOString(),
    ], {
      createReportState: (opts) => createReportState({
        ...opts,
        lockOptions: { botWaitMs: 50, stateWaitMs: 50, sleep: () => Promise.resolve() },
      }),
    });
    assert.equal(blocked.code, 3);
    assert.match(blocked.log.lines.join('\n'), /lock_timeout/);
    assert.ok(fs.existsSync(botLock));

    const log = quietLog();
    const broken = await runRoomReport([
      '--state', world.statePath,
      '--break-lock', 'ironbot',
    ], { log });
    assert.equal(broken, 0);
    assert.equal(fs.existsSync(botLock), false);
    assert.match(log.lines.join('\n'), /report_bot_lock_broken_by_operator/);

    const ok = await run(world, [
      '--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', BASE.toISOString(),
    ]);
    assert.equal(ok.code, 0);
  } finally {
    await world.stop();
  }
});

test('--break-state-lock removes state lock; invalid --break-lock exits 1 without FS touch', async () => {
  const world = await startWorld();
  try {
    const stateLock = `${world.statePath}.lock`;
    fs.writeFileSync(stateLock, JSON.stringify({
      pid: 1, host: 'h', token: 't', acquired_at: BASE.toISOString(),
    }));
    const log = quietLog();
    assert.equal(await runRoomReport(['--state', world.statePath, '--break-state-lock'], { log }), 0);
    assert.equal(fs.existsSync(stateLock), false);

    const before = fs.readdirSync(world.dir).sort();
    await assert.rejects(
      () => runRoomReport(['--state', world.statePath, '--break-lock', '../evil'], { log: quietLog() }),
      (err) => {
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /invalid bot id/);
        return true;
      },
    );
    assert.deepEqual(fs.readdirSync(world.dir).sort(), before);
  } finally {
    await world.stop();
  }
});

test('--drop-pending clears pending, exits 0, posts nothing', async () => {
  const world = await startWorld();
  try {
    const state = createReportState({ statePath: world.statePath });
    await state.savePending('ironbot', {
      state: 'sending',
      message_id: 'msg_x',
      idempotency_key: 'ironbots_ironbot_t',
      created_at: BASE.toISOString(),
      envelope: { message_id: 'msg_x' },
      report: { bot: 'ironbot', status: 'degraded', summary: 'x', timestamp: BASE.toISOString(), alerts: [] },
    });
    const log = quietLog();
    const code = await runRoomReport([
      '--identity', world.identityPath,
      '--relay-url', world.relayUrl,
      '--room', ROOM,
      '--state', world.statePath,
      '--bot', 'ironbot',
      '--drop-pending',
    ], { log, now: () => BASE });
    assert.equal(code, 0);
    assert.match(log.lines.join('\n'), /report_pending_dropped_by_operator/);
    assert.equal(await state.loadPending('ironbot'), null);
    const rows = await world.repository.listRoomMessages(ROOM, 0n, 10);
    assert.equal(rows.length, 0);
  } finally {
    await world.stop();
  }
});

test('first-send content refusal maps to exit 2; transient 401 maps to exit 3', async () => {
  const world = await startWorld();
  try {
    class Refuse extends RelayClient {
      async sendEnvelope() {
        throw Object.assign(new Error('mentions'), {
          status: 400,
          code: 'REPORT_MENTIONS_FORBIDDEN',
        });
      }
    }
    const refused = await run(world, [
      '--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', BASE.toISOString(),
    ], { RelayClient: Refuse });
    assert.equal(refused.code, 2);
    assert.match(refused.log.lines.join('\n'), /report_refused/);
    assert.equal(await createReportState({ statePath: world.statePath }).loadPending('ironbot'), null);

    const statePath2 = path.join(world.dir, 'auth-state.json');
    class AuthFail extends RelayClient {
      async sendEnvelope() {
        throw Object.assign(new Error('nope'), { status: 401, code: 'UNAUTHENTICATED' });
      }
    }
    const transient = await runRoomReport([
      '--identity', world.identityPath,
      '--relay-url', world.relayUrl,
      '--room', ROOM,
      '--state', statePath2,
      '--bot', 'ironbot',
      '--status', 'degraded',
      '--summary', 'x',
      '--report-at', BASE.toISOString(),
    ], { RelayClient: AuthFail, now: () => BASE, log: quietLog() });
    assert.equal(transient, 3);
    assert.ok(await createReportState({ statePath: statePath2 }).loadPending('ironbot'));
  } finally {
    await world.stop();
  }
});

test('exit-code mapping via stub postReport covers reconciled/policy/duplicate', async () => {
  const world = await startWorld();
  try {
    for (const [reason, expected] of [
      ['accepted', 0],
      ['duplicate', 0],
      ['reconciled', 0],
      ['policy', 0],
      ['already_posted', 0],
      ['refused', 2],
      ['transient', 3],
      ['pending', 3],
      ['lock_timeout', 3],
    ]) {
      const log = quietLog();
      const code = await runRoomReport(baseArgv(world, [
        '--bot', 'ironbot', '--status', 'degraded', '--summary', 'x', '--report-at', BASE.toISOString(),
      ]), {
        now: () => BASE,
        log,
        postReport: async () => ({ posted: reason === 'accepted' || reason === 'duplicate' || reason === 'reconciled', reason }),
      });
      assert.equal(code, expected, reason);
    }
  } finally {
    await world.stop();
  }
});
