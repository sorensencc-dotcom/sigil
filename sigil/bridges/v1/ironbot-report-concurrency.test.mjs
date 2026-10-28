// Task 11 concurrency: real child processes, fail-closed locks, no steal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from '../../relay/v1/http-server.mjs';
import { hashBearerToken } from '../../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { createReportState } from './ironbot-report.mjs';
import { acquireLock, breakLockFile } from './file-lock.mjs';

const BASE = new Date('2026-10-16T12:00:00.000Z');
const childPath = fileURLToPath(new URL('./fixtures/report-poster-child.mjs', import.meta.url));
const HARD_MS = 15_000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-report-conc-'));
}

function saveIdentity(dir, identity) {
  const p = path.join(dir, `${identity.endpoint_id}.json`);
  fs.writeFileSync(p, JSON.stringify(identity));
  return p;
}

async function startRelay({ reporters = 1, now = () => BASE, clock } = {}) {
  const clockNow = clock ? () => new Date(clock.now) : now;
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const agents = Array.from({ length: reporters }, (_, i) =>
    createIdentity({ ownerId: 'usr_chris', endpointId: `ep_reporter_${i}`, kind: 'agent' }));
  const all = [human, ...agents];
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
  for (const agent of agents) {
    await repository.addRoomMember({
      conversationId: 'room_fleet',
      endpointId: agent.endpoint_id,
      role: 'member',
      responseMode: 'report_only',
      addedByHumanId: 'usr_chris',
      now: BASE,
    });
  }
  const server = createRelayServer({ registry, repository, tokenHashes, now: clockNow });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    repository,
    relayUrl: `http://127.0.0.1:${server.address().port}`,
    agents,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function spawnChild(payload, { timeoutMs = HARD_MS } = {}) {
  const child = spawn(process.execPath, [childPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (line) {
        try { result = JSON.parse(line); } catch { /* ignore */ }
      }
      resolve({ code, result, stdout, stderr, pid: child.pid });
    });
  });
  return { child, done };
}

test('(a) two processes same bot same report: one created', async () => {
  const dir = tmpDir();
  const world = await startRelay();
  const children = [];
  try {
    const identityPath = saveIdentity(dir, world.agents[0]);
    const statePath = path.join(dir, 'state.json');
    const report = {
      bot: 'ironbot',
      status: 'degraded',
      timestamp: BASE.toISOString(),
      summary: 'same',
      alerts: [],
    };
    const payload = {
      identityPath,
      relayUrl: world.relayUrl,
      token: world.agents[0].relay_token,
      roomId: 'room_fleet',
      statePath,
      report,
      nowIso: BASE.toISOString(),
      botWaitMs: 2_000,
      httpTimeoutMs: 5_000,
    };
    const a = spawnChild(payload);
    const b = spawnChild(payload);
    children.push(a.child, b.child);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const results = [ra.result, rb.result].filter(Boolean);
    assert.ok(results.length >= 1, `no results: ${ra.stderr} ${rb.stderr}`);
    assert.equal(results.filter((r) => r.created === true).length, 1);
    const rows = await world.repository.listRoomMessages('room_fleet', 0n, 10);
    assert.equal(rows.filter((m) => m.envelope.message_type === 'room.message').length, 1);
    for (const r of results) {
      assert.ok(['accepted', 'already_posted', 'lock_timeout', 'duplicate'].includes(r.reason), r.reason);
    }
  } finally {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await world.stop();
  }
});

test('(b) two bots share state: both pendings survive transient then both clear', async () => {
  const dir = tmpDir();
  const clock = { now: BASE };
  const world = await startRelay({ reporters: 2, clock });
  const stub = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'UNAVAILABLE', message: 'down' }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${stub.address().port}`;
  const children = [];
  try {
    for (let round = 0; round < 20; round++) {
      const statePath = path.join(dir, `state-r${round}.json`);
      // Unique created_at / idempotency key per round so the shared relay does not
      // treat a later round's new envelope as DUPLICATE_MESSAGE of an earlier accept.
      // Fresh room per round keeps the 30/hour report_only cap from blocking later rounds.
      clock.now = new Date(BASE.getTime() + round * 60_000);
      const roundNow = clock.now.toISOString();
      const roomId = `room_fleet_r${round}`;
      await world.repository.createRoom({
        conversationId: roomId,
        workspaceId: 'ws_usr_chris',
        name: `fleet-${round}`,
        createdByHumanId: 'usr_chris',
        ownerEndpointId: 'ep_web',
      });
      for (const agent of world.agents) {
        await world.repository.addRoomMember({
          conversationId: roomId,
          endpointId: agent.endpoint_id,
          role: 'member',
          responseMode: 'report_only',
          addedByHumanId: 'usr_chris',
          now: clock.now,
        });
      }
      const reportA = {
        bot: 'botA', status: 'degraded', timestamp: roundNow, summary: 'a', alerts: [],
      };
      const reportB = {
        bot: 'botB', status: 'degraded', timestamp: roundNow, summary: 'b', alerts: [],
      };
      const payloadA = {
        identityPath: saveIdentity(dir, world.agents[0]),
        relayUrl: deadUrl,
        token: world.agents[0].relay_token,
        roomId,
        statePath,
        report: reportA,
        nowIso: roundNow,
        httpTimeoutMs: 3_000,
      };
      const payloadB = {
        identityPath: saveIdentity(dir, world.agents[1]),
        relayUrl: deadUrl,
        token: world.agents[1].relay_token,
        roomId,
        statePath,
        report: reportB,
        nowIso: roundNow,
        httpTimeoutMs: 3_000,
      };
      const ca = spawnChild(payloadA);
      const cb = spawnChild(payloadB);
      children.push(ca.child, cb.child);
      await Promise.all([ca.done, cb.done]);
      const state = createReportState({ statePath });
      assert.ok(await state.loadPending('botA'), `round ${round} botA pending`);
      assert.ok(await state.loadPending('botB'), `round ${round} botB pending`);

      const retryA = spawnChild({ ...payloadA, relayUrl: world.relayUrl });
      const retryB = spawnChild({ ...payloadB, relayUrl: world.relayUrl });
      children.push(retryA.child, retryB.child);
      const [ra, rb] = await Promise.all([retryA.done, retryB.done]);
      assert.ok(ra.result?.posted, JSON.stringify(ra.result) + ra.stderr);
      assert.ok(rb.result?.posted, JSON.stringify(rb.result) + rb.stderr);
      assert.equal(await state.loadPending('botA'), null);
      assert.equal(await state.loadPending('botB'), null);
      assert.ok((await state.lastPosted('botA'))?.last_key);
      assert.ok((await state.lastPosted('botB'))?.last_key);
    }
  } finally {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await new Promise((resolve) => stub.close(resolve));
    await world.stop();
  }
});

test('(c) two reclaimers against abandoned lock fail closed', async () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.json');
  const lockPath = `${statePath}.ironbot.lock`;
  fs.writeFileSync(statePath, JSON.stringify({
    bots: {
      ironbot: {
        status: null, at: null, last_key: null, recreate_count: 0,
        pending: {
          message_id: 'msg_x', idempotency_key: 'k', created_at: BASE.toISOString(),
          report: { status: 'degraded', summary: 'x', timestamp: BASE.toISOString() },
          envelope: {}, state: 'sending',
        },
      },
      otherbot: {
        status: null, at: null, last_key: null, recreate_count: 0,
        pending: {
          message_id: 'msg_y', idempotency_key: 'ky', created_at: BASE.toISOString(),
          report: { status: 'degraded', summary: 'y', timestamp: BASE.toISOString() },
          envelope: {}, state: 'sending',
        },
      },
    },
  }, null, 2));
  const dead = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
  await new Promise((r) => setTimeout(r, 30));
  const deadPid = dead.pid;
  dead.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: deadPid, host: 'dead', token: 'abandoned', acquired_at: BASE.toISOString(),
  }));
  const beforeLock = fs.readFileSync(lockPath);
  const beforeState = crypto.createHash('sha256').update(fs.readFileSync(statePath)).digest('hex');
  const sentinel = path.join(dir, 'sentinel');
  const world = await startRelay();
  const children = [];
  try {
    const identityPath = saveIdentity(dir, world.agents[0]);
    const payload = {
      identityPath,
      relayUrl: world.relayUrl,
      token: world.agents[0].relay_token,
      roomId: 'room_fleet',
      statePath,
      report: {
        bot: 'ironbot', status: 'degraded', timestamp: BASE.toISOString(), summary: 'x', alerts: [],
      },
      nowIso: BASE.toISOString(),
      botWaitMs: 100,
      sentinelPath: sentinel,
      httpTimeoutMs: 3_000,
    };
    const a = spawnChild(payload);
    const b = spawnChild(payload);
    children.push(a.child, b.child);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.result?.reason, 'lock_timeout', JSON.stringify(ra));
    assert.equal(rb.result?.reason, 'lock_timeout', JSON.stringify(rb));
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(fs.readFileSync(lockPath), beforeLock);
    const afterState = crypto.createHash('sha256').update(fs.readFileSync(statePath)).digest('hex');
    assert.equal(afterState, beforeState);
  } finally {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await world.stop();
  }
});


test('(d) paused live holder fails closed; other bot pending intact', async () => {
  const dir = tmpDir();
  const world = await startRelay({ reporters: 2 });
  const children = [];
  try {
    const statePath = path.join(dir, 'state.json');
    const state = createReportState({ statePath });
    // Seed otherbot pending so we can prove it survives.
    await state.savePending('otherbot', {
      message_id: 'msg_other',
      idempotency_key: 'k_other',
      created_at: BASE.toISOString(),
      report: { status: 'degraded', summary: 'y', timestamp: BASE.toISOString() },
      envelope: { message_id: 'msg_other' },
      state: 'sending',
    });
    const gatePath = path.join(dir, 'gate');
    const identityPath = saveIdentity(dir, world.agents[0]);
    const holderPayload = {
      identityPath,
      relayUrl: world.relayUrl,
      token: world.agents[0].relay_token,
      roomId: 'room_fleet',
      statePath,
      report: {
        bot: 'ironbot', status: 'degraded', timestamp: BASE.toISOString(), summary: 'hold', alerts: [],
      },
      nowIso: BASE.toISOString(),
      gatePath,
      holdMs: 30_000,
      botWaitMs: 5_000,
      httpTimeoutMs: 5_000,
    };
    const holder = spawnChild(holderPayload, { timeoutMs: 25_000 });
    children.push(holder.child);
    // Wait until holder has acquired the bot lock (lock file appears).
    const lockPath = `${statePath}.ironbot.lock`;
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fs.existsSync(lockPath), 'holder never acquired bot lock');
    const contender = spawnChild({
      ...holderPayload,
      botWaitMs: 200,
      gatePath: undefined,
      holdMs: 0,
    });
    children.push(contender.child);
    const cr = await contender.done;
    assert.equal(cr.result?.reason, 'lock_timeout', JSON.stringify(cr));
    // Release the holder.
    fs.writeFileSync(gatePath, 'go');
    const hr = await holder.done;
    assert.equal(hr.result?.posted, true, JSON.stringify(hr));
    assert.ok(await state.loadPending('otherbot'), 'otherbot pending must survive');
    assert.ok((await state.lastPosted('ironbot'))?.last_key);
  } finally {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await world.stop();
  }
});

test('(e) breakBotLock allows progress after abandoned lock', async () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.json');
  const state = createReportState({ statePath });
  const lockPath = `${statePath}.ironbot.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999, host: 'gone', token: 't', acquired_at: BASE.toISOString(),
  }));
  const world = await startRelay();
  const children = [];
  try {
    const identityPath = saveIdentity(dir, world.agents[0]);
    const payload = {
      identityPath,
      relayUrl: world.relayUrl,
      token: world.agents[0].relay_token,
      roomId: 'room_fleet',
      statePath,
      report: {
        bot: 'ironbot', status: 'degraded', timestamp: BASE.toISOString(), summary: 'break', alerts: [],
      },
      nowIso: BASE.toISOString(),
      botWaitMs: 50,
      httpTimeoutMs: 5_000,
    };
    const blocked = spawnChild(payload);
    children.push(blocked.child);
    const br = await blocked.done;
    assert.equal(br.result?.reason, 'lock_timeout');
    const diag = state.breakBotLock('ironbot');
    assert.equal(diag?.host, 'gone');
    assert.equal(fs.existsSync(lockPath), false);
    const ok = spawnChild({ ...payload, botWaitMs: 5_000 });
    children.push(ok.child);
    const or_ = await ok.done;
    assert.equal(or_.result?.posted, true, JSON.stringify(or_));
    assert.equal(or_.result?.reason, 'accepted');
  } finally {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await world.stop();
  }
});

test('(f) token-checked release does not delete new holder lock', async () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, 'bot.lock');
  const first = await acquireLock(lockPath, { waitMs: 0, host: 'h1' });
  breakLockFile(lockPath);
  const second = await acquireLock(lockPath, { waitMs: 0, host: 'h2' });
  first.release();
  assert.equal(fs.existsSync(lockPath), true);
  const diag = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(diag.host, 'h2');
  second.release();
});
