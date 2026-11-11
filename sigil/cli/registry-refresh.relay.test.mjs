import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createIdentity } from './identity.mjs';
import { addEndpointToRegistry, saveRegistryFile } from './registry-store.mjs';

const SIGIL_CLI_PATH = fileURLToPath(new URL('./sigil.mjs', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getInboxStatus(relayUrl, token) {
  const response = await fetch(`${relayUrl}/v1/inbox`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

test('running relay accepts a newly added bot and rejects a removed one without restarting', { timeout: 25000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-refresh-'));
  const registryPath = path.join(tmpDir, 'registry.json');

  const botA = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_a@fixture.example',
    kind: 'agent',
  });
  const botB = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_b@fixture.example',
    kind: 'agent',
  });

  addEndpointToRegistry(registryPath, botA);

  const child = spawn(
    process.execPath,
    [SIGIL_CLI_PATH, 'relay', 'up', '--registry', registryPath, '--port', '0'],
    {
      cwd: tmpDir,
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const waitForExit = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        waitForExit,
        sleep(3000).then(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }),
      ]);
      await waitForExit;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const initialPid = child.pid;
  assert.ok(initialPid, 'expected spawned relay pid');

  let relayUrl = null;
  const startDeadline = Date.now() + 10_000;
  while (Date.now() < startDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`relay exited early (code=${child.exitCode}, signal=${child.signalCode}): ${stderr || stdout}`);
    }
    const match = stdout.match(/Sigil relay listening on (http:\/\/127\.0\.0\.1:\d+)/i);
    if (match && stdout.includes('Ctrl+C to stop')) {
      relayUrl = match[1];
      break;
    }
    await sleep(50);
  }
  assert.ok(relayUrl, `timed out waiting for relay listening line; stdout=${stdout} stderr=${stderr}`);

  const initialStatusB = await getInboxStatus(relayUrl, botB.relay_token);
  assert.ok(initialStatusB === 401 || initialStatusB === 403, `expected 401/403 before add, got ${initialStatusB}`);

  addEndpointToRegistry(registryPath, botB);

  let addedAccepted = false;
  const addDeadline = Date.now() + 10_000;
  while (Date.now() < addDeadline) {
    const status = await getInboxStatus(relayUrl, botB.relay_token);
    if (status === 200) {
      addedAccepted = true;
      break;
    }
    await sleep(100);
  }
  assert.equal(addedAccepted, true, 'expected newly added bot token to be accepted with 200 before deadline');
  assert.equal(child.pid, initialPid);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  saveRegistryFile(registryPath, {
    endpoints: [{
      owner_id: botA.owner_id,
      endpoint_id: botA.endpoint_id,
      key_id: botA.key_id,
      kind: botA.kind,
      status: 'active',
      public_key_pem: botA.public_key_pem,
      relay_token: botA.relay_token,
    }],
  });

  let removedRejected = false;
  const removeDeadline = Date.now() + 10_000;
  while (Date.now() < removeDeadline) {
    const status = await getInboxStatus(relayUrl, botB.relay_token);
    if (status === 401 || status === 403) {
      removedRejected = true;
      break;
    }
    await sleep(100);
  }
  assert.equal(removedRejected, true, 'expected removed bot token to be rejected with 401/403 before deadline');
  assert.equal(child.pid, initialPid);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(await getInboxStatus(relayUrl, botA.relay_token), 200);
});

function openStream(streamUrl, token, sockets) {
  const ws = new WebSocket(streamUrl, [`sigil-bearer.${token}`]);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForClose(ws, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for websocket close`));
    }, timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

test('running relay closes live streams on removal and rotation and leaves other bots connected', { timeout: 25000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-stream-revoke-'));
  const registryPath = path.join(tmpDir, 'registry.json');

  const botA = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_a@fixture.example',
    kind: 'agent',
  });
  const botB = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_b@fixture.example',
    kind: 'agent',
  });
  const botC = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_c@fixture.example',
    kind: 'agent',
  });
  const newTokenC = createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: 'ep_fixture_c_rotated@fixture.example',
    kind: 'agent',
  }).relay_token;

  addEndpointToRegistry(registryPath, botA);
  addEndpointToRegistry(registryPath, botB);
  addEndpointToRegistry(registryPath, botC);

  const child = spawn(
    process.execPath,
    [SIGIL_CLI_PATH, 'relay', 'up', '--registry', registryPath, '--port', '0'],
    {
      cwd: tmpDir,
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const waitForExit = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  const sockets = [];
  t.after(async () => {
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
        s.terminate();
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        waitForExit,
        sleep(3000).then(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }),
      ]);
      await waitForExit;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let streamUrl = null;
  const startDeadline = Date.now() + 10_000;
  while (Date.now() < startDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`relay exited early (code=${child.exitCode}, signal=${child.signalCode}): ${stderr || stdout}`);
    }
    const match = stdout.match(/Sigil stream \(push notify\) on (ws:\/\/127\.0\.0\.1:\d+\/v1\/stream)/i);
    if (match && stdout.includes('Ctrl+C to stop')) {
      streamUrl = match[1];
      break;
    }
    await sleep(50);
  }
  assert.ok(streamUrl, `timed out waiting for stream listening line; stdout=${stdout} stderr=${stderr}`);

  const wsA = await openStream(streamUrl, botA.relay_token, sockets);
  const wsB = await openStream(streamUrl, botB.relay_token, sockets);
  const wsC = await openStream(streamUrl, botC.relay_token, sockets);

  const closeBPromise = waitForClose(wsB, 10_000);
  saveRegistryFile(registryPath, {
    endpoints: [
      {
        owner_id: botA.owner_id,
        endpoint_id: botA.endpoint_id,
        key_id: botA.key_id,
        kind: botA.kind,
        status: 'active',
        public_key_pem: botA.public_key_pem,
        relay_token: botA.relay_token,
      },
      {
        owner_id: botC.owner_id,
        endpoint_id: botC.endpoint_id,
        key_id: botC.key_id,
        kind: botC.kind,
        status: 'active',
        public_key_pem: botC.public_key_pem,
        relay_token: botC.relay_token,
      },
    ],
  });

  const closedB = await closeBPromise;
  assert.equal(closedB.code, 1008);
  assert.equal(closedB.reason, 'revoked');
  assert.equal(wsA.readyState, 1);
  assert.equal(wsC.readyState, 1);

  const closeCPromise = waitForClose(wsC, 10_000);
  addEndpointToRegistry(registryPath, { ...botC, relay_token: newTokenC });

  const closedC = await closeCPromise;
  assert.equal(closedC.code, 1008);
  assert.equal(closedC.reason, 'revoked');
  assert.equal(wsA.readyState, 1);

  const wsCNew = await openStream(streamUrl, newTokenC, sockets);
  assert.equal(wsCNew.readyState, 1);
  assert.equal(wsA.readyState, 1);

  const combinedOutput = `${stdout}\n${stderr}`;
  for (const secretToken of [botA.relay_token, botB.relay_token, botC.relay_token, newTokenC]) {
    assert.equal(combinedOutput.includes(secretToken), false, 'relay output must not contain bearer tokens');
  }
});
