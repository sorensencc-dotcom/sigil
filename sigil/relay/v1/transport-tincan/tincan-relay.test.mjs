import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHeldQueue } from './held-queue.mjs';
import { createWakeDispatcher } from './wake-dispatcher.mjs';
import {
  createTailscaleWhoIs, createTincanRelay, isLoopbackAddress, listenTincanRelay, loadTincanConfig, normalizeRemoteAddress, parseTincanArgs,
} from './tincan-relay.mjs';

const node = { Node: { Key: 'nodekey:gpu', Name: 'gpu-1' }, UserProfile: { LoginName: 'soren@tailnet' } };
const allowlist = new Map([['nodekey:gpu', { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]);
const hosted = {
  bridgeType: 'codex',
  identityPath: 'codex.identity.json',
  relayUrl: 'http://127.0.0.1:8791',
  sessionStore: '.sigil/room-sessions.json',
};
const deliveryBody = {
  delivery: { conversation_id: 'room_1', invocation_id: 'inv_1' },
  sender_endpoint: 'ep_codex',
  target_endpoint: 'ep_codex',
  identity_path: 'evil.json',
};

function envelope() {
  return {
    protocol: 'sigil/1', message_id: 'msg_1', sender: { endpoint_id: 'ep_claude' },
    message_type: 'room.message', capabilities: ['fs.write'], body: { text: 'x' }, signature: { value: 's' },
  };
}

async function boot({ remoteAddress = '100.64.0.2', whois = async () => node, wakeError = null, callbackSecret = 'callback-secret', nodeAllowlist = allowlist } = {}) {
  const wakes = [];
  const fails = [];
  const released = [];
  const dispatcher = createWakeDispatcher({
    checkRunningFn: async () => false,
    spawnFn: async (command, args) => {
      if (wakeError) throw wakeError;
      wakes.push({ command, args });
      return { pid: 42 };
    },
  });
  let callbackUrl = 'http://127.0.0.1:9/v1/approval-callback';
  const relay = createTincanRelay({
    allowlist: nodeAllowlist,
    tailscale: { whois },
    dispatcher,
    heldQueue: createHeldQueue({
      callbackUrl: () => callbackUrl,
      submitChallengeFn: async (body) => ({ challenge_id: 'ch_1', echoed: body.callback_url }),
    }),
    failFn: async (roomId, reason, invocationId) => { fails.push({ roomId, reason, invocationId }); },
    callbackSecret,
    endpoints: new Map([['ep_codex', hosted]]),
    onReleased: async (value, actionHash) => { released.push({ value, actionHash }); },
    remoteAddressOf: () => remoteAddress,
    sleepFn: async () => {},
  });
  const listening = await listenTincanRelay(relay);
  callbackUrl = listening.callbackUrl;
  return { relay, listening, wakes, fails, released, callbackUrl };
}

async function post(port, pathname, body, { bearer } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.startsWith('{') ? JSON.parse(text) : null;
  return { status: response.status, json, text, type: response.headers.get('content-type') };
}

test('normalizeRemoteAddress strips v4-mapped IPv6 and isLoopbackAddress accepts only loopback', () => {
  assert.equal(normalizeRemoteAddress('::ffff:100.64.0.2'), '100.64.0.2');
  assert.equal(normalizeRemoteAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('100.64.0.2'), false);
});

test('authorized dispatch wakes the hosted endpoint and ignores a peer-supplied identity path', async () => {
  const ctx = await boot();
  try {
    const result = await post(ctx.listening.dispatchPort, '/v1/dispatch', deliveryBody);
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'DELIVERED');
    assert.equal(result.json.pid, 42);
    assert.equal(result.json.endpointId, 'ep_codex');
    assert.ok(ctx.wakes[0].args.includes('--identity'));
    assert.ok(ctx.wakes[0].args.includes('codex.identity.json'));
    assert.equal(ctx.wakes[0].args.includes('evil.json'), false);
    assert.ok(ctx.wakes[0].args.includes('--room-bridge'));
    assert.ok(ctx.wakes[0].args.includes('codex'));
    assert.deepEqual(ctx.fails, []);
  } finally {
    await ctx.listening.close();
  }
});

test('an unauthorized target never wakes', async () => {
  const ctx = await boot();
  try {
    const result = await post(ctx.listening.dispatchPort, '/v1/dispatch', { ...deliveryBody, target_endpoint: 'ep_rogue' });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT');
    assert.equal(ctx.wakes.length, 0);
  } finally {
    await ctx.listening.close();
  }
});

test('a whois failure fails closed and a missing hosted endpoint does not wake', async () => {
  const closed = await boot({ whois: async () => { throw Object.assign(new Error('down'), { code: 1 }); } });
  try {
    const result = await post(closed.listening.dispatchPort, '/v1/dispatch', deliveryBody);
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'UNAUTHORIZED_NODE');
    assert.equal(closed.wakes.length, 0);
  } finally {
    await closed.listening.close();
  }
  const permitted = new Map([['nodekey:gpu', { permitted_endpoints: ['ep_codex', 'ep_other'], allowed_host_roles: ['agent_runner'] }]]);
  const missing = await boot({ nodeAllowlist: permitted });
  try {
    const result = await post(missing.listening.dispatchPort, '/v1/dispatch', { ...deliveryBody, target_endpoint: 'ep_other' });
    assert.equal(result.status, 404);
    assert.equal(result.json.code, 'ENDPOINT_NOT_HOSTED');
    assert.equal(missing.wakes.length, 0);
  } finally {
    await missing.listening.close();
  }
});

test('dispatch rejects bad JSON and the callback listener does not expose dispatch', async () => {
  const ctx = await boot();
  try {
    const bad = await post(ctx.listening.dispatchPort, '/v1/dispatch', '{');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'INVALID_REQUEST');
    const hidden = await post(ctx.listening.callbackPort, '/v1/dispatch', deliveryBody);
    assert.equal(hidden.status, 404);
    const hiddenCallback = await fetch(`http://127.0.0.1:${ctx.listening.dispatchPort}/v1/approval-callback`);
    assert.equal(hiddenCallback.status, 404);
  } finally {
    await ctx.listening.close();
  }
});

test('wake timeouts fail the invocation once', async () => {
  const ctx = await boot({ wakeError: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
  try {
    const result = await post(ctx.listening.dispatchPort, '/v1/dispatch', deliveryBody);
    assert.equal(result.status, 502);
    assert.equal(result.json.reason, 'wake_timeout');
    assert.deepEqual(ctx.fails, [{ roomId: 'room_1', reason: 'wake_timeout', invocationId: 'inv_1' }]);
  } finally {
    await ctx.listening.close();
  }
});

test('GET approval callback releases the held envelope only from loopback', async () => {
  const ctx = await boot({ remoteAddress: '127.0.0.1' });
  try {
    const held = await ctx.relay.holdForApproval(envelope(), 'tok');
    assert.equal(held.challengeId, 'ch_1');
    const ok = await fetch(`${ctx.callbackUrl}?token=ch_1`);
    const html = await ok.text();
    assert.equal(ok.status, 200);
    assert.match(html, /Approved/);
    assert.equal(ctx.released.length, 1);
    assert.equal(ctx.released[0].actionHash, held.actionHash);
    const again = await fetch(`${ctx.callbackUrl}?token=ch_1`);
    assert.equal(again.status, 404);
  } finally {
    await ctx.listening.close();
  }

  const remote = await boot({ remoteAddress: '100.64.0.2' });
  try {
    await remote.relay.holdForApproval(envelope(), 'tok');
    const blocked = await fetch(`${remote.callbackUrl}?token=ch_1`);
    assert.equal(blocked.status, 403);
    assert.equal(remote.released.length, 0);
  } finally {
    await remote.listening.close();
  }
});

test('POST approval callback requires the bearer secret and releases by action hash', async () => {
  const ctx = await boot({ remoteAddress: '127.0.0.1' });
  try {
    const held = await ctx.relay.holdForApproval(envelope(), 'tok');
    const denied = await post(ctx.listening.callbackPort, '/v1/approval-callback', { action_hash: held.actionHash }, { bearer: 'nope' });
    assert.equal(denied.status, 401);
    assert.equal(ctx.released.length, 0);
    const ok = await post(ctx.listening.callbackPort, '/v1/approval-callback', { action_hash: held.actionHash }, { bearer: 'callback-secret' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'RELEASED');
    assert.equal(ok.json.action_hash, held.actionHash);
    const second = await post(ctx.listening.callbackPort, '/v1/approval-callback', { action_hash: held.actionHash }, { bearer: 'callback-secret' });
    assert.equal(second.status, 404);
    assert.equal(second.json.code, 'HELD_ENVELOPE_NOT_FOUND');
  } finally {
    await ctx.listening.close();
  }
});

test('loadTincanConfig reads the allowlist and rejects an unknown bridge', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tincan-'));
  const file = path.join(dir, 'tincan.json');
  await writeFile(file, JSON.stringify({
    allowlist: { 'nodekey:gpu': { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] } },
    endpoints: { ep_codex: { bridge_type: 'codex', identity_path: 'codex.identity.json', relay_url: 'http://127.0.0.1:8791' } },
  }));
  const loaded = await loadTincanConfig(file);
  assert.deepEqual(loaded.endpoints.get('ep_codex').bridgeType, 'codex');
  assert.deepEqual(loaded.allowlist.get('nodekey:gpu').permitted_endpoints, ['ep_codex']);
  await writeFile(file, JSON.stringify({
    allowlist: { 'nodekey:gpu': { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] } },
    endpoints: { ep_codex: { bridge_type: 'grok', identity_path: 'x.json', relay_url: 'http://127.0.0.1:8791' } },
  }));
  await assert.rejects(loadTincanConfig(file), { code: 'CONFIG_INVALID' });
});

test('parseTincanArgs requires a config path and createTailscaleWhoIs parses whois JSON', async () => {
  assert.equal(parseTincanArgs(['--config', 'tincan.json', '--tailnet']).tailnet, true);
  await assert.rejects(async () => parseTincanArgs([]), { code: 'INVALID_REQUEST' });
  const calls = [];
  const client = createTailscaleWhoIs({
    execFileFn: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify({ Node: { Key: 'nodekey:abc', Name: 'gpu-1' } }) };
    },
  });
  const who = await client.whois('100.64.0.2');
  assert.equal(who.Node.Key, 'nodekey:abc');
  assert.deepEqual(calls[0], ['tailscale', ['whois', '--json', '100.64.0.2']]);
});
