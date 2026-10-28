#!/usr/bin/env node
// Child fixture for ironbot-report-concurrency tests. Prints one JSON result line.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { LocalOutbox } from '../../../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../../../connectors/v1/relay-client.mjs';
import {
  createReportState,
  createReportPolicy,
  postReport,
} from '../ironbot-report.mjs';

const args = JSON.parse(fs.readFileSync(0, 'utf8'));
const {
  identityPath,
  relayUrl,
  token,
  roomId,
  statePath,
  report,
  nowIso,
  resendAsNew = false,
  botWaitMs,
  httpTimeoutMs = 5_000,
  sentinelPath = null,
  gatePath = null,
  holdMs = 0,
} = args;

const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
const privateKey = crypto.createPrivateKey(identity.private_key_pem);
const outbox = new LocalOutbox({
  privateKey,
  endpoint: {
    owner_id: identity.owner_id,
    endpoint_id: identity.endpoint_id,
    key_id: identity.key_id,
    kind: identity.kind,
  },
});
const relay = new RelayClient({ baseUrl: relayUrl, token: token ?? identity.relay_token });
const now = () => new Date(nowIso ?? Date.now());
const state = createReportState({
  statePath,
  now,
  lockOptions: botWaitMs != null ? { botWaitMs, stateWaitMs: Math.min(botWaitMs, 5_000) } : {},
});
const policy = createReportPolicy({ state, now });

if (sentinelPath || gatePath) {
  const previous = state.withBotLock.bind(state);
  state.withBotLock = async (bot, fn) => previous(bot, async () => {
    if (sentinelPath) fs.writeFileSync(sentinelPath, 'entered');
    // Hold the bot lock until the parent drops the gate file (paused-holder test).
    if (gatePath) {
      const deadline = Date.now() + (holdMs || 30_000);
      while (!fs.existsSync(gatePath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return fn();
  });
}

try {
  const result = await postReport({
    identity,
    relay,
    outbox,
    roomId,
    report,
    policy,
    state,
    now,
    resendAsNew,
    httpTimeoutMs,
    log: null,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ posted: false, reason: 'error', error: String(error.message || error) })}\n`);
  process.exitCode = 1;
}
