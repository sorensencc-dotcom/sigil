import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHeldQueue } from './held-queue.mjs';
import { createWakeDispatcher } from './wake-dispatcher.mjs';
import { createTailscaleWhoIs, createTincanRelay, listenTincanRelay } from './tincan-relay.mjs';

const execFileAsync = promisify(execFile);
const live = process.env.SIGIL_TINCAN_LIVE === '1';

test('a dispatch posted at this host Tailscale address passes real WhoIs and wakes', { skip: !live }, async () => {
  const ip = (await execFileAsync('tailscale', ['ip', '-4'], { windowsHide: true, timeout: 8000 })).stdout.trim();
  const tailscale = createTailscaleWhoIs();
  const who = await tailscale.whois(ip);
  const seen = [];
  const wakes = [];
  const relay = createTincanRelay({
    allowlist: new Map([[who.Node.Key, { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]),
    tailscale: {
      whois: async (address) => {
        seen.push(address);
        return tailscale.whois(address);
      },
    },
    dispatcher: createWakeDispatcher({
      checkRunningFn: async () => false,
      spawnFn: async (_command, args) => { wakes.push(args); return { pid: 7 }; },
    }),
    heldQueue: createHeldQueue({ callbackUrl: 'http://127.0.0.1:9/cb', submitChallengeFn: async () => ({ challenge_id: 'ch_live' }) }),
    failFn: async () => { throw new Error('failFn should not run'); },
    callbackSecret: 'live-callback-secret',
    endpoints: new Map([['ep_codex', {
      bridgeType: 'codex', identityPath: 'codex.identity.json', relayUrl: 'http://127.0.0.1:8791',
    }]]),
  });
  const listening = await listenTincanRelay(relay, { dispatchHost: ip, dispatchPort: 0, callbackHost: '127.0.0.1', callbackPort: 0 });
  try {
    const response = await fetch(`http://${ip}:${listening.dispatchPort}/v1/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        delivery: { conversation_id: 'room_live', invocation_id: 'inv_live' },
        sender_endpoint: 'ep_codex',
        target_endpoint: 'ep_codex',
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ status: response.status, body, seen }));
    assert.equal(body.status, 'DELIVERED');
    assert.equal(seen[0], ip);
    assert.ok(wakes[0].includes('codex'));
  } finally {
    await listening.close();
  }
});
