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
import { fileURLToPath } from 'node:url';

import http from 'node:http';
import { WebSocket } from 'ws';

import { createIdentity, loadIdentity, saveIdentity, identityKeys } from './identity.mjs';
import { loadRegistryFile, addEndpointToRegistry, toRegistryMap, toTokenHashes } from './registry-store.mjs';
import { createMemoryRepository } from './memory-repository.mjs';
import { sendWithOptionalReceiptWait } from './send-with-receipt.mjs';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { createStreamServer } from '../relay/v1/stream-server.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';
import { formatInboxItem, INBOX_WAIT_EXIT_CODES, waitForOneInboxMessage, isRetryableInboxWaitExitCode } from './inbox-wait.mjs';
import { appendInboxLedger, readInboxLedger } from './ledger.mjs';

const DEFAULT_CLI_CONFIG = path.join('.sigil', 'config.json');

const DEFAULT_REGISTRY = path.join('.sigil', 'registry.json');

function usage() {
  console.log(`sigil <command> [options]

Commands:
  init <name> --owner <owner_id> [--registry path] [--domain domain]      Create a local identity and register it (domain defaults to "local")
  relay up [--registry path] [--port N] [--enable-mock-oidc] [--oidc-issuer-refresh-interval-ms N] [--domain domain] Run a local relay (blocks; Ctrl+C to stop)
  oidc-issuer add <issuer> --client-id id [--label text] [--assurance level] [--database-url url]
                                                            Provision a real OIDC issuer for /v1/auth/login (requires --database-url or SIGIL_DATABASE_URL; restart the relay, or wait for the next poll, to pick it up)
  oidc-issuer list [--database-url url]                    List all OIDC issuer allow-list entries, including disabled ones
  oidc-issuer remove <issuer> [--database-url url]         Disable an OIDC issuer (soft-disable; re-add with "oidc-issuer add" to re-enable)
  send [--identity path] [--relay-url url] [--stream-url url] [--wait-for-receipt] --to endpoint_id --to-owner owner_id --message "text" [--conversation id]
  inbox [--identity path] [--relay-url url] [--watch|--wait] [--loop] [--stream-url url] [--interval ms] [--timeout ms] [--local] [--ledger path]
  doctor [--identity path] [--relay-url url]               Conformance check: JCS/dependency audits, plus a keypair check (if --identity)
                                                            and a relay connectivity/latency check (if --relay-url)

send/inbox resolve --identity/--relay-url/--stream-url from, in order: the flag, then
SIGIL_IDENTITY/SIGIL_RELAY_URL/SIGIL_STREAM_URL env vars, then .sigil/config.json
(default_identity/relay_url/stream_url), then a local default (relay-url only).

Everything here runs on this machine. See docs/meta/sigil-cli-roadmap.md for what's missing for real multi-user use.`);
}

function opt(args, flags, fallback) {
  for (const flag of flags) if (args.values[flag] !== undefined) return args.values[flag];
  return fallback;
}

function flushPrint(line) {
  return new Promise((resolve, reject) => {
    process.stdout.write(line + '\n', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const NAME_CHARSET = /^[a-z0-9_-]+$/;

async function cmdInit(argv) {
  const args = parseArgs({ args: argv, options: { owner: { type: 'string' }, registry: { type: 'string' }, kind: { type: 'string' }, domain: { type: 'string' } }, allowPositionals: true });
  const name = args.positionals[0];
  if (!name) throw new Error('usage: sigil init <name> --owner <owner_id> [--domain domain]');
  if (!NAME_CHARSET.test(name)) throw new Error(`sigil init: <name> "${name}" must match ${NAME_CHARSET} (it becomes the federated id's local part)`);
  const domain = opt(args, ['domain']) ?? 'local';
  const { parseDomain, parseFederatedId, isLocalDomain, resolveDomainOrThrow } = await import('../relay/v1/federated-id.mjs');
  const { host: domainHost } = parseDomain(domain);
  if (domainHost !== 'local') await resolveDomainOrThrow(domain);
  const owner = opt(args, ['owner']) ?? `usr_${name}@${domain}`;
  if (opt(args, ['owner']) !== undefined) {
    parseFederatedId(owner);
    if (!isLocalDomain(owner, domain)) throw Object.assign(new Error(`sigil init: --owner domain must match --domain`), { code: 'OWNER_DOMAIN_MISMATCH' });
  }
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const identityPath = path.join('.sigil', `${name}.identity.json`);
  const identity = createIdentity({ ownerId: owner, endpointId: `ep_${name}@${domain}`, kind: opt(args, ['kind']) ?? 'human' });
  saveIdentity(identityPath, identity);
  addEndpointToRegistry(registryPath, identity);
  console.log(`Created identity: ${identityPath}`);
  console.log(`Registered ${identity.endpoint_id} (owner ${identity.owner_id}) in ${registryPath}`);
  console.log(`\nKeep ${identityPath} private -- it holds this endpoint's private key and tokens.`);
}

// Refreshes `allowlistSet` in place from `repository.listOidcIssuerAllowlist()`
// on an interval, so `sigil oidc-issuer add`/`remove` take effect without a
// relay restart. Fetches into a temp array first and only clears+repopulates
// the real Set on success -- a DB hiccup during a poll logs and keeps the
// last-known Set rather than emptying it. Only meaningful when polling a
// shared Postgres allow-list; callers should not start this against the
// in-memory repository. Returns the interval handle (already unref()'d) so a
// test can clearInterval it instead of waiting for process exit.
export function startOidcIssuerAllowlistPolling({ repository, allowlistSet, intervalMs = 30_000 }) {
  return setInterval(async () => {
    try {
      const entries = await repository.listOidcIssuerAllowlist();
      allowlistSet.clear();
      for (const entry of entries) allowlistSet.add(entry.issuer);
    } catch (error) {
      console.error(`sigil: OIDC issuer allow-list poll failed, keeping last-known list: ${error.message}`);
    }
  }, intervalMs).unref();
}

async function cmdRelayUp(argv) {
  const args = parseArgs({ args: argv, options: { registry: { type: 'string' }, port: { type: 'string' }, 'stream-port': { type: 'string' }, 'database-url': { type: 'string' }, 'enable-mock-oidc': { type: 'boolean' }, 'oidc-issuer-refresh-interval-ms': { type: 'string' }, domain: { type: 'string' } } });
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const port = Number(opt(args, ['port']) ?? 0);
  const streamPort = Number(opt(args, ['stream-port']) ?? (port ? port + 1 : 0));
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  const enableMockOidc = Boolean(args.values['enable-mock-oidc']) || process.env.SIGIL_ENABLE_MOCK_OIDC === '1';
  const oidcIssuerRefreshIntervalMsRaw = opt(args, ['oidc-issuer-refresh-interval-ms']);
  const oidcIssuerRefreshIntervalMs = oidcIssuerRefreshIntervalMsRaw === undefined ? 30_000 : Number(oidcIssuerRefreshIntervalMsRaw);
  if (!Number.isInteger(oidcIssuerRefreshIntervalMs) || oidcIssuerRefreshIntervalMs <= 0) {
    throw new Error(`--oidc-issuer-refresh-interval-ms must be a positive integer, got "${oidcIssuerRefreshIntervalMsRaw}"`);
  }
  const relayDomain = opt(args, ['domain']);
  if (relayDomain !== undefined) {
    const { parseDomain } = await import('../relay/v1/federated-id.mjs');
    parseDomain(relayDomain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else runs
  }
  const data = loadRegistryFile(registryPath);
  if (!data.endpoints.length) throw new Error(`No endpoints in ${registryPath}. Run "sigil init <name> --owner <owner_id>" first.`);
  const registry = toRegistryMap(data);
  const tokenHashes = toTokenHashes(data);
  let repository;
  if (databaseUrl) {
    const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
    await applyMigrations(databaseUrl);
    const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl });
    repository = new PostgresRepository({ pool });

    if (enableMockOidc) {
      const { FIXTURE_ISSUER } = await import('../relay/v1/mock-oidc.mjs');
      await repository.upsertMockOidcIssuerAllowlist({ issuer: FIXTURE_ISSUER });
    }

    for (const ep of data.endpoints) {
      await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW()) ON CONFLICT (human_id) DO NOTHING`, [ep.owner_id]);
      await pool.query(`
        INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'active', NOW())
        ON CONFLICT (endpoint_id) DO UPDATE SET status = 'active'
      `, [ep.endpoint_id, ep.owner_id, ep.kind ?? 'agent', `install_${ep.endpoint_id}`, ep.endpoint_id]);
      if (ep.public_key_pem) {
        const pubKeyBuf = crypto.createPublicKey(ep.public_key_pem).export({ type: 'spki', format: 'der' });
        await pool.query(`
          INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
          VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())
          ON CONFLICT (key_id) DO NOTHING
        `, [ep.key_id, ep.endpoint_id, pubKeyBuf]);
      }
    }
  } else {
    repository = createMemoryRepository();
  }

  // Stream server needs its own http.Server (createRelayServer builds one
  // internally and doesn't accept an existing one), so push notifications
  // run on a second port, separate from the main relay HTTP port.
  const streamHttpServer = http.createServer();
  const stream = createStreamServer({ server: streamHttpServer, tokenHashes });
  await new Promise((resolve) => streamHttpServer.listen(streamPort, '127.0.0.1', resolve));
  const streamAddress = streamHttpServer.address();

  const oidcIssuerAllowList = new Set((await repository.listOidcIssuerAllowlist()).map((entry) => entry.issuer));
  // Only meaningful when persisting to Postgres -- polling a single-process
  // in-memory repository for changes nothing else can make is pointless.
  if (databaseUrl) startOidcIssuerAllowlistPolling({ repository, allowlistSet: oidcIssuerAllowList, intervalMs: oidcIssuerRefreshIntervalMs });

  let server;
  const relayOrigin = () => {
    const addr = server?.address();
    return addr ? `http://127.0.0.1:${addr.port}` : `http://127.0.0.1:${port}`;
  };
  server = createRelayServer({ registry, repository, tokenHashes, stream, relayOrigin, enableMockOidc, oidcIssuerAllowList, relayDomain });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (enableMockOidc) console.log('WARNING: mock-OIDC login is enabled (--enable-mock-oidc). This is for local development and CI only -- never expose this relay to untrusted networks.');
  console.log(`Sigil relay listening on http://127.0.0.1:${address.port}`);
  console.log(`Sigil stream (push notify) on ws://127.0.0.1:${streamAddress.port}/v1/stream`);
  console.log(`Registered endpoints: ${[...registry.keys()].join(', ')}`);
  console.log(databaseUrl ? `Persisting to PostgreSQL database (${databaseUrl.replace(/:[^:@]+@/, ':***@')}). Ctrl+C to stop.` : 'In-memory only -- state is lost when this process exits. Ctrl+C to stop.');
  await new Promise(() => {}); // keep the process alive
}

async function cmdSend(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, 'stream-url': { type: 'string' }, 'wait-for-receipt': { type: 'boolean' }, to: { type: 'string' }, 'to-owner': { type: 'string' }, message: { type: 'string' }, conversation: { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { relayUrl: opt(args, ['relay-url']), streamUrl: opt(args, ['stream-url']), identity: opt(args, ['identity']) }, config });
  if (!resolved.identityPath) throw new Error('usage: sigil send --identity path --relay-url url --to endpoint_id --to-owner owner_id --message "text" (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)');
  const identity = loadIdentity(resolved.identityPath);
  const relayUrl = resolved.relayUrl;
  const to = opt(args, ['to']);
  const toOwner = opt(args, ['to-owner']);
  const message = opt(args, ['message']);
  if (!relayUrl || !to || !toOwner || !message) throw new Error('usage: sigil send --identity path --relay-url url --to endpoint_id --to-owner owner_id --message "text"');
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
  const waitForReceipt = args.values['wait-for-receipt'];
  const streamUrl = waitForReceipt
    ? (resolved.streamUrl ?? (() => { const url = new URL(relayUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.port = String(Number(url.port || 80) + 1); url.pathname = '/v1/stream'; return url.toString(); })())
    : null;
  await sendWithOptionalReceiptWait({
    relay, envelope: queued.envelope, waitForReceipt, streamUrl, token: identity.relay_token,
    print: (line) => console.log(line),
  });
}

async function cmdInbox(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, 'stream-url': { type: 'string' }, watch: { type: 'boolean' }, wait: { type: 'boolean' }, loop: { type: 'boolean' }, local: { type: 'boolean' }, ledger: { type: 'string' }, interval: { type: 'string' }, timeout: { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { relayUrl: opt(args, ['relay-url']), streamUrl: opt(args, ['stream-url']), identity: opt(args, ['identity']) }, config });
  if (!resolved.identityPath) throw new Error('usage: sigil inbox --identity path --relay-url url [--watch] (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)');
  const identity = loadIdentity(resolved.identityPath);
  const ledgerPath = opt(args, ['ledger']) ?? path.join(path.dirname(resolved.identityPath), 'inbox.jsonl');

  if (Boolean(args.values.local)) {
    const records = await readInboxLedger(ledgerPath);
    if (!records.length) {
      console.log('(local inbox empty)');
    } else {
      for (const record of records) {
        console.log(formatInboxItem(record));
      }
    }
    return;
  }

  const relayUrl = resolved.relayUrl;
  const relay = new RelayClient({ baseUrl: relayUrl, token: identity.relay_token });
  const watch = Boolean(args.values.watch);
  const wait = Boolean(args.values.wait);
  const loop = Boolean(args.values.loop);
  if (watch && wait) throw new Error('use either --watch or --wait, not both');
  if (loop && !wait) throw new Error('--loop requires --wait');
  const streamUrl = resolved.streamUrl ?? (() => { const url = new URL(relayUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.port = String((Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) + 1)); url.pathname = '/v1/stream'; return url.toString(); })();
  let since = '';
  const poll = async () => {
    const page = await relay.reconcileInbox(since);
    for (const item of page.items) {
      if (ledgerPath) {
        await appendInboxLedger(ledgerPath, {
          received_at: new Date().toISOString(),
          delivery_id: item.delivery_id,
          envelope: item.envelope ?? item,
        });
      }
      await flushPrint(formatInboxItem(item));
      if (item.delivery_id) await relay.acknowledge(item.delivery_id);
    }
    since = page.nextSince ?? since;
    return page.items.length;
  };
  if (wait) {
    const timeoutMs = Number(opt(args, ['timeout']) ?? 300_000);
    let retryDelayMs = 250;
    do {
      try {
        await waitForOneInboxMessage({ relay, identity, streamUrl, timeoutMs, print: flushPrint, ledgerPath });
        retryDelayMs = 250;
      } catch (error) {
        if (!loop || !isRetryableInboxWaitExitCode(error.exitCode)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    } while (loop);
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

async function cmdOidcIssuerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'client-id': { type: 'string' }, label: { type: 'string' }, assurance: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  const clientId = opt(args, ['client-id']);
  if (!issuer || !clientId) throw new Error('usage: sigil oidc-issuer add <issuer> --client-id <id> [--label text] [--assurance level] [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil oidc-issuer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to provision');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    await repository.upsertOidcIssuerAllowlist({ issuer, clientId, displayLabel: opt(args, ['label']) ?? issuer, assuranceLevel: opt(args, ['assurance']) ?? 'standard' });
    console.log(`Added ${issuer} (client_id ${clientId}) to the OIDC issuer allow-list. Restart the relay to pick it up.`);
  } finally {
    await pool.end();
  }
}

async function cmdOidcIssuerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil oidc-issuer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to list');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const entries = await repository.listOidcIssuerAllowlist({ includeDisabled: true });
    for (const entry of entries) console.log(`${entry.issuer}\t${entry.clientId ?? ''}\t${entry.enabled}\t${entry.assuranceLevel}`);
  } finally {
    await pool.end();
  }
}

async function cmdOidcIssuerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  if (!issuer) throw new Error('usage: sigil oidc-issuer remove <issuer> [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil oidc-issuer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to modify');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    await repository.disableOidcIssuerAllowlist(issuer);
    console.log(`Disabled ${issuer} in the OIDC issuer allow-list. Restart the relay, or wait for the next poll, to pick it up.`);
  } finally {
    await pool.end();
  }
}

function printDoctorReport(result) {
  const printCheck = (label, check) => {
    if (!check) return console.log(`${label}: skipped`);
    const ok = check.pass ?? check.ok;
    console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}`);
    if (check.issues) for (const issue of check.issues) console.log(`  [${issue.severity}] ${issue.code} (${issue.file}): ${issue.message}`);
    if (check.keyId) console.log(`  key_id: ${check.keyId}`);
    if (typeof check.latencyMs === 'number') console.log(`  latency: ${check.latencyMs}ms`);
    if (check.error) console.log(`  error: ${check.error}`);
  };
  printCheck('JCS conformance', result.checks.jcs);
  printCheck('Dependency audit', result.checks.dep);
  printCheck('Keypair', result.checks.keypair);
  printCheck('Relay connectivity', result.checks.relay);
  console.log(result.pass ? 'sigil doctor: PASS' : 'sigil doctor: FAIL');
}

async function cmdDoctor(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { identity: opt(args, ['identity']) }, config });
  const { runDoctor } = await import('./doctor.mjs');
  const result = await runDoctor({
    identityPath: resolved.identityPath ?? undefined,
    relayUrl: opt(args, ['relay-url']),
  });
  printDoctorReport(result);
  if (!result.pass) process.exitCode = 1;
}

async function cmdAgentRun(argv) {
  const args = parseArgs({ args: argv, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, 'stream-url': { type: 'string' }, worker: { type: 'string' }, config: { type: 'string' } } });
  const config = loadConfigFile(opt(args, ['config']) ?? DEFAULT_CLI_CONFIG);
  const resolved = resolveConfig({ flags: { relayUrl: opt(args, ['relay-url']), streamUrl: opt(args, ['stream-url']), identity: opt(args, ['identity']) }, config });
  if (!resolved.identityPath) throw new Error('usage: sigil agent run --identity path --relay-url url [--worker path]');
  const identity = loadIdentity(resolved.identityPath);
  const { fileURLToPath } = await import('node:url');
  const workerScript = opt(args, ['worker']) ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-worker.mjs');
  const { createAgentDaemon } = await import('./agent-daemon.mjs');
  const daemon = createAgentDaemon({
    identity,
    relayUrl: resolved.relayUrl,
    streamUrl: resolved.streamUrl,
    workerCommand: process.execPath,
    workerArgs: [workerScript],
    autoReply: true
  });
  console.log(`Sigil autonomous agent daemon running for ${identity.endpoint_id} (${identity.owner_id}).`);
  console.log(`Relay: ${resolved.relayUrl}`);
  console.log(`Worker: ${workerScript}`);
  console.log('Listening for inbound task envelopes. Press Ctrl+C to stop.');
  daemon.start();
  await new Promise(() => {});
}

export async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  try {
    if (command === 'init') await cmdInit(process.argv.slice(3));
    else if (command === 'relay' && sub === 'up') await cmdRelayUp(rest);
    else if (command === 'oidc-issuer' && sub === 'add') await cmdOidcIssuerAdd(rest);
    else if (command === 'oidc-issuer' && sub === 'list') await cmdOidcIssuerList(rest);
    else if (command === 'oidc-issuer' && sub === 'remove') await cmdOidcIssuerRemove(rest);
    else if (command === 'agent' && sub === 'run') await cmdAgentRun(rest);
    else if (command === 'doctor') await cmdDoctor(process.argv.slice(3));
    else if (command === 'send') await cmdSend(process.argv.slice(3));
    else if (command === 'inbox') await cmdInbox(process.argv.slice(3));
    else usage();
  } catch (error) {
    console.error(`sigil: ${error.message}`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
