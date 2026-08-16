#!/usr/bin/env node
// Sigil CLI -- thin wrapper over the library code in sigil/relay and
// sigil/connectors so a person can send/receive a signed message between
// two local endpoints without hand-writing a script each time.
//
// Local-machine demo only tonight: `sigil relay up` runs an in-process
// relay with an in-memory store (see cli/memory-repository.mjs). It is not
// a hosted service, does not persist across restarts, and has no directory
// of other people's endpoints -- see docs/meta/sigil-cli-roadmap.md for
// what a real multi-user version would need.
import { parseArgs } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';

import http from 'node:http';
import { WebSocket } from 'ws';

import { createIdentity, loadIdentity, saveIdentity, identityKeys } from './identity.mjs';
import { loadRegistryFile, addEndpointToRegistry, toRegistryMap, toTokenHashes } from './registry-store.mjs';
import { createMemoryRepository } from './memory-repository.mjs';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { createStreamServer } from '../relay/v1/stream-server.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';
import { formatInboxItem, waitForOneInboxMessage } from './inbox-wait.mjs';

const DEFAULT_CLI_CONFIG = path.join('.sigil', 'config.json');

const DEFAULT_REGISTRY = path.join('.sigil', 'registry.json');

function usage() {
  console.log(`sigil <command> [options]

Commands:
  init <name> --owner <owner_id> [--registry path]        Create a local identity and register it
  relay up [--registry path] [--port N]                    Run a local relay (blocks; Ctrl+C to stop)
  send [--identity path] [--relay-url url] --to endpoint_id --to-owner owner_id --message "text" [--conversation id]
  inbox [--identity path] [--relay-url url] [--watch|--wait] [--stream-url url] [--interval ms] [--timeout ms]

send/inbox resolve --identity/--relay-url/--stream-url from, in order: the flag, then
SIGIL_IDENTITY/SIGIL_RELAY_URL/SIGIL_STREAM_URL env vars, then .sigil/config.json
(default_identity/relay_url/stream_url), then a local default (relay-url only).

Everything here runs on this machine. See docs/meta/sigil-cli-roadmap.md for what's missing for real multi-user use.`);
}

function opt(args, flags, fallback) {
  for (const flag of flags) if (args.values[flag] !== undefined) return args.values[flag];
  return fallback;
}

async function cmdInit(argv) {
  const args = parseArgs({ args: argv, options: { owner: { type: 'string' }, registry: { type: 'string' }, kind: { type: 'string' } }, allowPositionals: true });
  const name = args.positionals[0];
  if (!name) throw new Error('usage: sigil init <name> --owner <owner_id>');
  const owner = opt(args, ['owner']) ?? `usr_${name}`;
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const identityPath = path.join('.sigil', `${name}.identity.json`);
  const identity = createIdentity({ ownerId: owner, endpointId: `ep_${name}`, kind: opt(args, ['kind']) ?? 'human' });
  saveIdentity(identityPath, identity);
  addEndpointToRegistry(registryPath, identity);
  console.log(`Created identity: ${identityPath}`);
  console.log(`Registered ${identity.endpoint_id} (owner ${identity.owner_id}) in ${registryPath}`);
  console.log(`\nKeep ${identityPath} private -- it holds this endpoint's private key and tokens.`);
}

async function cmdRelayUp(argv) {
  const args = parseArgs({ args: argv, options: { registry: { type: 'string' }, port: { type: 'string' }, 'stream-port': { type: 'string' } } });
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const port = Number(opt(args, ['port']) ?? 0);
  const streamPort = Number(opt(args, ['stream-port']) ?? (port ? port + 1 : 0));
  const data = loadRegistryFile(registryPath);
  if (!data.endpoints.length) throw new Error(`No endpoints in ${registryPath}. Run "sigil init <name> --owner <owner_id>" first.`);
  const registry = toRegistryMap(data);
  const tokenHashes = toTokenHashes(data);
  const repository = createMemoryRepository();

  // Stream server needs its own http.Server (createRelayServer builds one
  // internally and doesn't accept an existing one), so push notifications
  // run on a second port, separate from the main relay HTTP port.
  const streamHttpServer = http.createServer();
  const stream = createStreamServer({ server: streamHttpServer, tokenHashes });
  await new Promise((resolve) => streamHttpServer.listen(streamPort, '127.0.0.1', resolve));
  const streamAddress = streamHttpServer.address();

  const server = createRelayServer({ registry, repository, tokenHashes, stream });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  console.log(`Sigil relay listening on http://127.0.0.1:${address.port}`);
  console.log(`Sigil stream (push notify) on ws://127.0.0.1:${streamAddress.port}/v1/stream`);
  console.log(`Registered endpoints: ${[...registry.keys()].join(', ')}`);
  console.log('In-memory only -- state is lost when this process exits. Ctrl+C to stop.');
  await new Promise(() => {}); // keep the process alive
}

async function cmdSend(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, to: { type: 'string' }, 'to-owner': { type: 'string' }, message: { type: 'string' }, conversation: { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { relayUrl: opt(args, ['relay-url']), identity: opt(args, ['identity']) }, config });
  const identity = loadIdentity(resolved.identityPath);
  const relayUrl = resolved.relayUrl;
  const to = opt(args, ['to']);
  const toOwner = opt(args, ['to-owner']);
  const message = opt(args, ['message']);
  if (!resolved.identityPath) throw new Error('usage: sigil send --identity path --relay-url url --to endpoint_id --to-owner owner_id --message "text" (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)');
  if (!to || !toOwner || !message) throw new Error('usage: sigil send --identity path --relay-url url --to endpoint_id --to-owner owner_id --message "text"');
  const keys = identityKeys(identity);
  const outbox = new LocalOutbox({ privateKey: keys.privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });
  const now = new Date();
  const conversationId = opt(args, ['conversation']) ?? `conv_${crypto.randomUUID()}`;
  const unsigned = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: conversationId,
    message_type: 'chat.message', sender: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, kind: identity.kind },
    recipient: { owner_id: toOwner, endpoint_id: to },
    body: { text: message }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: identity.key_id, value: '' }
  };
  const queued = outbox.queue(unsigned);
  const relay = new RelayClient({ baseUrl: relayUrl, token: identity.relay_token });
  const result = await relay.sendEnvelope(queued.envelope);
  console.log(`Sent. message_id=${result.message_id} conversation_id=${conversationId} duplicate=${result.duplicate}`);
}

async function cmdInbox(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, 'stream-url': { type: 'string' }, watch: { type: 'boolean' }, wait: { type: 'boolean' }, interval: { type: 'string' }, timeout: { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { relayUrl: opt(args, ['relay-url']), streamUrl: opt(args, ['stream-url']), identity: opt(args, ['identity']) }, config });
  if (!resolved.identityPath) throw new Error('usage: sigil inbox --identity path --relay-url url [--watch] (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)');
  const identity = loadIdentity(resolved.identityPath);
  const relayUrl = resolved.relayUrl;
  const relay = new RelayClient({ baseUrl: relayUrl, token: identity.relay_token });
  const watch = Boolean(args.values.watch);
  const wait = Boolean(args.values.wait);
  if (watch && wait) throw new Error('use either --watch or --wait, not both');
  const streamUrl = resolved.streamUrl ?? (() => { const url = new URL(relayUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.port = String((Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) + 1)); url.pathname = '/v1/stream'; return url.toString(); })();
  let since = '';
  const poll = async () => {
    const page = await relay.reconcileInbox(since);
    for (const item of page.items) {
      console.log(formatInboxItem(item));
      if (item.delivery_id) await relay.acknowledge(item.delivery_id);
    }
    since = page.nextSince ?? since;
    return page.items.length;
  };
  if (wait) {
    await waitForOneInboxMessage({ relay, identity, streamUrl, timeoutMs: Number(opt(args, ['timeout']) ?? 300_000) });
    return;
  }
  if (!watch) {
    const count = await poll();
    if (!count) console.log('(inbox empty)');
    return;
  }
  console.log(`Watching inbox for ${identity.endpoint_id} via ${streamUrl}. Ctrl+C to stop.`);
  let stopped = false; let socket; let reconnectDelay = 250; let fallbackTimer; let reconnectTimer;
  const scheduleReconnect = () => { if (stopped || reconnectTimer) return; reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30_000); };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(streamUrl, { headers: { authorization: `Bearer ${identity.relay_token}` } });
    socket.once('open', () => { reconnectDelay = 250; });
    socket.on('message', async (raw) => { try { const event = JSON.parse(raw); if (event.type === 'delivered') await poll(); } catch (error) { console.error(`sigil: stream message failed: ${error.message}`); } });
    socket.once('error', () => { try { socket.close(); } catch {} });
    socket.once('close', scheduleReconnect);
  };
  fallbackTimer = setInterval(() => { poll().catch((error) => console.error(`sigil: fallback inbox poll failed: ${error.message}`)); }, 30_000);
  connect();
  await new Promise(() => {});
}

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  try {
    if (command === 'init') await cmdInit(process.argv.slice(3));
    else if (command === 'relay' && sub === 'up') await cmdRelayUp(rest);
    else if (command === 'send') await cmdSend(process.argv.slice(3));
    else if (command === 'inbox') await cmdInbox(process.argv.slice(3));
    else usage();
  } catch (error) {
    console.error(`sigil: ${error.message}`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}

main();
