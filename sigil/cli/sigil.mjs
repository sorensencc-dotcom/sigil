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
import fs from 'node:fs';
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
import { signContract, verifyContract } from './contract-signing.mjs';
import { checkRelayConnectivity } from './doctor.mjs';

const DEFAULT_CLI_CONFIG = path.join('.sigil', 'config.json');

const DEFAULT_REGISTRY = path.join('.sigil', 'registry.json');

function usage() {
  console.log(`sigil <command> [options]

Commands:
  init <name> [--owner <owner_id> | --federation-owner <federated_id>] [--registry path] [--domain domain]      Create a local identity and register it (domain defaults to "local"; --federation-owner allows an owner id whose domain differs from --domain)
  sign-contract --contract path --identity path [--output path]          Sign a TorqueQuery agent dispatch contract
  verify-contract --contract path --registry path                        Verify a signed TorqueQuery agent dispatch contract
  relay up [--registry path] [--port N] [--enable-mock-oidc] [--oidc-issuer-refresh-interval-ms N] [--domain domain] [--federation-mode sync|queue] [--federation-identity path] Run a local relay (blocks; Ctrl+C to stop)
  oidc-issuer add <issuer> --client-id id [--label text] [--assurance level] [--database-url url]
                                                            Provision a real OIDC issuer for /v1/auth/login (requires --database-url or SIGIL_DATABASE_URL; restart the relay, or wait for the next poll, to pick it up)
  oidc-issuer list [--database-url url]                    List all OIDC issuer allow-list entries, including disabled ones
  oidc-issuer remove <issuer> [--database-url url]         Disable an OIDC issuer (soft-disable; re-add with "oidc-issuer add" to re-enable)
  peer resolve <domain> [--database-url url]               Discover and TOFU-pin a peer relay via https://<domain>/.well-known/sigil
  peer resolve --all [--database-url url]                  Re-resolve every tofu-pinned peer; continues past per-domain failure, exits non-zero if any failed
  peer validate-document <path> [--domain <domain>]        Validate a local .well-known/sigil JSON file offline -- no network, no database
  peer add <domain> --relay-url url --public-key key --kid id [--ws-url url] [--confirm] [--database-url url]
                                                            Manually (statically) pin a peer relay -- never auto-updated by discovery
                                                            (--confirm required to overwrite an existing pin)
  peer list [--database-url url]                           List all pinned peer relays
  peer get <domain> [--database-url url]                   Show one pinned peer relay
  peer remove <domain> [--database-url url]                Unpin a peer relay
  peer rotate <domain> --confirm [--database-url url]      Force-overwrite a pinned peer's key set, bypassing the TOFU mismatch check
  federation outbox list [--database-url url]              List queue-mode federation forward jobs: state counts, then one row per job (no envelope bodies)
  federation outbox show <id> [--database-url url]         Show one federation_outbox row's metadata (no envelope body)
  federation outbox retry <id> [--database-url url]        Re-queue a forward_rejected / dead_letter row for another forward attempt
  route test <recipient_federated_id> --identity path --relay-url url [--database-url url] [--registry path]
                                                            Read-only federation routing check: parse recipient, peer-directory pin lookup, /v1/health reachability, advisory same-owner line -- sends no envelope
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
  const args = parseArgs({ args: argv, options: { owner: { type: 'string' }, 'federation-owner': { type: 'string' }, registry: { type: 'string' }, kind: { type: 'string' }, domain: { type: 'string' } }, allowPositionals: true });
  const name = args.positionals[0];
  if (!name) throw new Error('usage: sigil init <name> [--owner <owner_id> | --federation-owner <federated_id>] [--domain domain]');
  if (!NAME_CHARSET.test(name)) throw new Error(`sigil init: <name> "${name}" must match ${NAME_CHARSET} (it becomes the federated id's local part)`);
  const domain = opt(args, ['domain']) ?? 'local';
  const { parseDomain, parseFederatedId, isLocalDomain, resolveDomainOrThrow } = await import('../relay/v1/federated-id.mjs');
  const { host: domainHost } = parseDomain(domain);
  if (domainHost !== 'local') await resolveDomainOrThrow(domain);
  const explicitOwner = opt(args, ['owner']);
  const federationOwner = opt(args, ['federation-owner']);
  if (explicitOwner !== undefined && federationOwner !== undefined) {
    throw new Error('sigil init: both --owner and --federation-owner given; pass at most one');
  }
  let owner;
  if (federationOwner !== undefined) {
    // #3 sub-project amendment: a deliberately cross-domain owner id, so one
    // owner can be shared verbatim across federated relays and the receiver's
    // same-owner exemption can fire. OWNER_DOMAIN_MISMATCH is suppressed for
    // this flag only; the id must still be a well-formed federated id.
    parseFederatedId(federationOwner);
    owner = federationOwner;
  } else if (explicitOwner !== undefined) {
    parseFederatedId(explicitOwner);
    if (!isLocalDomain(explicitOwner, domain)) throw Object.assign(new Error(`sigil init: --owner domain must match --domain`), { code: 'OWNER_DOMAIN_MISMATCH' });
    owner = explicitOwner;
  } else {
    owner = `usr_${name}@${domain}`;
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
  const args = parseArgs({ args: argv, options: { registry: { type: 'string' }, port: { type: 'string' }, 'stream-port': { type: 'string' }, 'database-url': { type: 'string' }, 'enable-mock-oidc': { type: 'boolean' }, 'oidc-issuer-refresh-interval-ms': { type: 'string' }, domain: { type: 'string' }, 'federation-mode': { type: 'string' }, 'federation-identity': { type: 'string' } } });
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
  let isLocalDomain;
  if (relayDomain !== undefined) {
    const federatedId = await import('../relay/v1/federated-id.mjs');
    federatedId.parseDomain(relayDomain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else runs
    isLocalDomain = federatedId.isLocalDomain;
  }
  const federationMode = opt(args, ['federation-mode']);
  let federationIdentity;
  if (federationMode !== undefined) {
    if (!['sync', 'queue'].includes(federationMode)) throw new Error('sigil relay up: --federation-mode must be "sync" or "queue"');
    if (relayDomain === undefined) throw new Error('sigil relay up: --federation-mode requires --domain');
    const identityPath = opt(args, ['federation-identity']);
    if (!identityPath) throw new Error('sigil relay up: --federation-mode requires --federation-identity <path>');
    federationIdentity = loadIdentity(identityPath); // throws on missing / non-JSON
    if (federationMode === 'queue' && !databaseUrl) throw new Error('sigil relay up: --federation-mode queue requires --database-url (or SIGIL_DATABASE_URL); in-memory relays have no durable outbox');
  }
  const data = loadRegistryFile(registryPath);
  if (!data.endpoints.length) throw new Error(`No endpoints in ${registryPath}. Run "sigil init <name> --owner <owner_id>" first.`);
  if (relayDomain !== undefined && !data.endpoints.some((ep) => isLocalDomain(ep.endpoint_id, relayDomain))) {
    console.log(`WARNING: no endpoint in ${registryPath} belongs to domain "${relayDomain}" -- every envelope will be rejected with RECIPIENT_NOT_LOCAL. Register an endpoint with "sigil init <name> --owner <owner_id> --domain ${relayDomain}", or drop --domain.`);
  }
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
    repository = createMemoryRepository({ registry });
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
  server = createRelayServer({ registry, repository, tokenHashes, stream, relayOrigin, enableMockOidc, oidcIssuerAllowList, relayDomain, federationMode, federationIdentity });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  let federationReaperTimer;
  if (federationMode === 'queue') {
    const { startFederationReaper } = await import('../relay/v1/federation-reaper.mjs');
    federationReaperTimer = startFederationReaper({ repository, identity: federationIdentity, originDomain: relayDomain });
    console.log('Federation outbox reaper running (60s interval).');
  }
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

// Shared by every command that needs a durable (Postgres-backed) repository:
// resolve --database-url/SIGIL_DATABASE_URL, optionally migrate, open a pool,
// run fn(repository), always close the pool. `requireDatabaseUrl` is the
// command-specific error message so each caller keeps its own wording.
async function withRepository(args, requireDatabaseUrl, fn, { migrate = false } = {}) {
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error(requireDatabaseUrl);
  if (migrate) {
    const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
    await applyMigrations(databaseUrl);
  }
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await fn(new PostgresRepository({ pool }));
  } finally {
    await pool.end();
  }
}

async function cmdOidcIssuerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'client-id': { type: 'string' }, label: { type: 'string' }, assurance: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  const clientId = opt(args, ['client-id']);
  if (!issuer || !clientId) throw new Error('usage: sigil oidc-issuer add <issuer> --client-id <id> [--label text] [--assurance level] [--database-url url]');
  await withRepository(args, 'sigil oidc-issuer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to provision', async (repository) => {
    await repository.upsertOidcIssuerAllowlist({ issuer, clientId, displayLabel: opt(args, ['label']) ?? issuer, assuranceLevel: opt(args, ['assurance']) ?? 'standard' });
    console.log(`Added ${issuer} (client_id ${clientId}) to the OIDC issuer allow-list. Restart the relay to pick it up.`);
  }, { migrate: true });
}

async function cmdOidcIssuerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  await withRepository(args, 'sigil oidc-issuer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to list', async (repository) => {
    const entries = await repository.listOidcIssuerAllowlist({ includeDisabled: true });
    for (const entry of entries) console.log(`${entry.issuer}\t${entry.clientId ?? ''}\t${entry.enabled}\t${entry.assuranceLevel}`);
  });
}

async function cmdOidcIssuerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  if (!issuer) throw new Error('usage: sigil oidc-issuer remove <issuer> [--database-url url]');
  await withRepository(args, 'sigil oidc-issuer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to modify', async (repository) => {
    await repository.disableOidcIssuerAllowlist(issuer);
    console.log(`Disabled ${issuer} in the OIDC issuer allow-list. Restart the relay, or wait for the next poll, to pick it up.`);
  });
}

// Validates `domain` via federated-id's parseDomain() before any peer
// subcommand touches the repository or network, folding the thrown error's
// `.code` (e.g. INVALID_DOMAIN_SYNTAX) into the message so it's visible on
// stderr -- scoped to this task's `peer` commands only, not a change to how
// errors are reported anywhere else in the CLI.
async function requireValidPeerDomain(domain) {
  const { parseDomain } = await import('../relay/v1/federated-id.mjs');
  try {
    parseDomain(domain);
  } catch (error) {
    throw new Error(`${error.message} (${error.code})`);
  }
}

async function cmdPeerValidateDocument(argv) {
  const args = parseArgs({ args: argv, options: { domain: { type: 'string' } }, allowPositionals: true });
  const filePath = args.positionals[0];
  if (!filePath) throw new Error('usage: sigil peer validate-document <path> [--domain <domain>]');
  const expectedDomain = opt(args, ['domain']);
  if (expectedDomain !== undefined) await requireValidPeerDomain(expectedDomain); // keeps "every sigil peer subcommand validates domain input" true with no exception (/plan-ceo-review outside-voice finding OV2)
  const { validatePeerDocument } = await import('../relay/v1/peer-discovery.mjs');
  let raw;
  try {
    raw = await (await import('node:fs/promises')).readFile(filePath, 'utf8');
  } catch (error) {
    console.error(`sigil peer validate-document: cannot read "${filePath}": ${error.code ?? error.message}`);
    process.exitCode = 1;
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`sigil peer validate-document: "${filePath}" is not valid JSON`);
    process.exitCode = 1;
    return;
  }
  try {
    const record = validatePeerDocument(data, { expectedDomain });
    console.log(`Valid .well-known/sigil document for "${record.domain}".`);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    console.error(`sigil peer validate-document: ${error.code} — ${error.message}`);
    process.exitCode = 1;
  }
}

// Pure formatting on an already-stored field -- no schema change. Surfaces
// staleness for an operator, since this plan deliberately has no background
// poller (see Global Constraints) to do it automatically.
export function freshness(lastResolvedAt, now = new Date()) {
  if (!lastResolvedAt) return 'never resolved';
  const days = Math.floor((now - new Date(lastResolvedAt)) / 86400000);
  return days <= 0 ? 'resolved today' : `resolved ${days}d ago`;
}

async function cmdPeerResolveAll(args) {
  await withRepository(args, 'sigil peer resolve --all requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
    const peers = (await repository.listPeers()).filter((p) => p.trustMode === 'tofu');
    let anyFailed = false;
    for (const peer of peers) {
      try {
        await resolvePeer(peer.domain, repository);
        console.log(`${peer.domain}\tOK`);
      } catch (error) {
        anyFailed = true;
        const suffix = error.code === 'PEER_KEY_MISMATCH' ? ` — run "sigil peer rotate ${peer.domain} --confirm"` : ` (${error.message})`;
        console.log(`${peer.domain}\t${error.code ?? 'ERROR'}${suffix}`);
      }
    }
    if (anyFailed) process.exitCode = 1;
  }, { migrate: true });
}

async function cmdPeerResolve(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' }, all: { type: 'boolean' } }, allowPositionals: true });
  if (args.values.all) return cmdPeerResolveAll(args);
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer resolve <domain> [--database-url url]');
  await requireValidPeerDomain(domain);
  try {
    await withRepository(args, 'sigil peer resolve requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
      const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
      const record = await resolvePeer(domain, repository);
      console.log(JSON.stringify(record, null, 2));
    }, { migrate: true });
  } catch (error) {
    if (error.code === 'PEER_KEY_MISMATCH') {
      console.error(`sigil peer resolve: peer "${domain}" changed`);
      if (error.keysChanged) {
        console.error(`  pinned keys:  ${error.pinnedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
        console.error(`  fetched keys: ${error.fetchedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      }
      if (error.endpointChanged) {
        console.error(`  pinned relay:  ${error.pinnedRelayUrl} (ws: ${error.pinnedWsUrl ?? 'none'})`);
        console.error(`  fetched relay: ${error.fetchedRelayUrl} (ws: ${error.fetchedWsUrl ?? 'none'})`);
      }
      console.error(`  Run "sigil peer rotate ${domain} --confirm" to accept the change.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function cmdPeerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'relay-url': { type: 'string' }, 'ws-url': { type: 'string' }, 'public-key': { type: 'string' }, kid: { type: 'string' }, confirm: { type: 'boolean' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  const relayUrl = opt(args, ['relay-url']);
  const publicKey = opt(args, ['public-key']);
  const kid = opt(args, ['kid']);
  if (!domain || !relayUrl || !publicKey || !kid) throw new Error('usage: sigil peer add <domain> --relay-url <url> --public-key <key> --kid <id> [--ws-url <url>] [--database-url url]');
  await requireValidPeerDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else runs
  const { isValidEndpointUrl, isValidWsEndpointUrl, isValidKeyEntry } = await import('../relay/v1/peer-discovery.mjs');
  if (!isValidEndpointUrl(relayUrl)) throw new Error(`sigil peer add: --relay-url "${relayUrl}" is not a valid https:// URL (http:// only allowed outside NODE_ENV=production)`);
  const wsUrl = opt(args, ['ws-url']) ?? null;
  if (wsUrl !== null && !isValidWsEndpointUrl(wsUrl)) throw new Error(`sigil peer add: --ws-url "${wsUrl}" is not a valid wss:// URL`);
  if (!isValidKeyEntry({ kid, alg: 'Ed25519', publicKey })) throw new Error('sigil peer add: --kid/--public-key must be non-empty');
  await withRepository(args, 'sigil peer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const existing = await repository.getPeerByDomain(domain);
    if (existing && !args.values.confirm) {
      throw new Error(`sigil peer add: "${domain}" is already pinned (trustMode=${existing.trustMode}) -- pass --confirm to overwrite`);
    }
    await repository.upsertPeer({ domain, relayUrl, wsUrl, keys: [{ kid, alg: 'Ed25519', publicKey }], trustMode: 'static' });
    // Overwriting a prior pin can swap the key material under a reused kid --
    // record what was there before so that swap is visible in the audit trail.
    const payload = existing
      ? { relayUrl, kid, previousRelayUrl: existing.relayUrl, previousWsUrl: existing.wsUrl, previousKeys: existing.keys, previousTrustMode: existing.trustMode }
      : { relayUrl, kid };
    await repository.recordAuditEvent({ eventType: 'peer.static_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload });
    console.log(`Statically pinned ${domain} -> ${relayUrl} (kid ${kid}).`);
  }, { migrate: true });
}

async function cmdPeerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  await withRepository(args, 'sigil peer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const peers = await repository.listPeers();
    for (const peer of peers) console.log(`${peer.domain}\t${peer.relayUrl}\t${peer.trustMode}\t${peer.keys.map((k) => k.kid).join(',')}\t(${freshness(peer.lastResolvedAt)})`);
  });
}

async function cmdPeerGet(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer get <domain> [--database-url url]');
  await requireValidPeerDomain(domain);
  await withRepository(args, 'sigil peer get requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const peer = await repository.getPeerByDomain(domain);
    console.log(peer ? `${JSON.stringify(peer, null, 2)}\n(${freshness(peer.lastResolvedAt)})` : `No peer pinned for "${domain}".`);
  });
}

async function cmdPeerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer remove <domain> [--database-url url]');
  await requireValidPeerDomain(domain);
  await withRepository(args, 'sigil peer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const removed = await repository.removePeer(domain);
    if (removed) {
      await repository.recordAuditEvent({ eventType: 'peer.removed', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: {} });
      console.log(`Removed peer pin for "${domain}".`);
    } else {
      console.log(`No peer pinned for "${domain}".`);
    }
  });
}

async function cmdPeerRotate(argv) {
  const args = parseArgs({ args: argv, options: { confirm: { type: 'boolean' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer rotate <domain> --confirm [--database-url url]');
  if (!args.values.confirm) throw new Error('sigil peer rotate requires --confirm -- this force-overwrites a pinned peer key without the usual TOFU mismatch check');
  await requireValidPeerDomain(domain);
  await withRepository(args, 'sigil peer rotate requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const { rotatePeer } = await import('../relay/v1/peer-discovery.mjs');
    const existing = await repository.getPeerByDomain(domain);
    if (existing?.trustMode === 'static') {
      console.error(`sigil peer rotate: WARNING - "${domain}" was statically pinned; this downgrades it to tofu trust.`);
    }
    const record = await rotatePeer(domain, repository);
    console.log(JSON.stringify(record, null, 2));
  }, { migrate: true });
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

async function cmdSignContract(argv) {
  const args = parseArgs({ args: argv, options: { contract: { type: 'string' }, identity: { type: 'string' }, output: { type: 'string' } } });
  const contractPath = opt(args, ['contract']);
  const identityPath = opt(args, ['identity']);
  if (!contractPath || !identityPath) throw new Error('usage: sigil sign-contract --contract path --identity path [--output path]');
  const identity = loadIdentity(identityPath);
  const signed = signContract(JSON.parse(fs.readFileSync(contractPath, 'utf8')), { privateKey: identityKeys(identity).privateKey, keyId: identity.key_id });
  const outputPath = opt(args, ['output']) ?? contractPath;
  fs.writeFileSync(outputPath, JSON.stringify(signed, null, 2) + '\n');
  console.log(JSON.stringify({ signed: true, contract: outputPath }));
}

async function cmdVerifyContract(argv) {
  const args = parseArgs({ args: argv, options: { contract: { type: 'string' }, registry: { type: 'string' } } });
  const contractPath = opt(args, ['contract']);
  const registryPath = opt(args, ['registry']);
  if (!contractPath || !registryPath) throw new Error('usage: sigil verify-contract --contract path --registry path');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const registry = loadRegistryFile(registryPath);
  const entry = registry.endpoints.find((candidate) => candidate.key_id === contract?.signature?.key_id);
  const valid = Boolean(entry) && verifyContract(contract, { publicKey: crypto.createPublicKey(entry.public_key_pem) });
  console.log(JSON.stringify(valid ? { valid: true, key_id: contract.signature.key_id } : { valid: false, reason: entry ? 'SIGNATURE_INVALID' : 'SIGNING_KEY_NOT_REGISTERED' }));
  if (!valid) process.exitCode = 1;
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

// `sigil federation outbox list|show|retry` -- inspect and re-queue the
// queue-mode federation forward jobs in federation_outbox (Task 13 repo
// methods). Never prints an envelope body: `list` rows are already
// body-stripped by listFederationOutbox; `show` omits envelope/senderKey
// before printing.
async function cmdFederation(argv) {
  const [group, action, ...rest] = argv;
  const actions = ['list', 'show', 'retry'];
  if (group !== 'outbox' || !actions.includes(action)) {
    throw new Error('usage: sigil federation outbox <list|show|retry> [<id>] [--database-url url]');
  }
  const args = parseArgs({ args: rest, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const requireMsg = 'sigil federation outbox requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable outbox';

  if (action === 'list') {
    await withRepository(args, requireMsg, async (repository) => {
      const { counts, rows } = await repository.listFederationOutbox();
      console.log(`pending=${counts.pending}  processing=${counts.processing}  forwarded=${counts.forwarded}  forward_rejected=${counts.forward_rejected}  dead_letter=${counts.dead_letter}`);
      console.log('id\tstate\trecipient_domain\tattempt_count\tnext_attempt_at\tlast_reason_code');
      for (const row of rows) {
        console.log(`${row.id}\t${row.state}\t${row.recipientDomain}\t${row.attemptCount}\t${row.nextAttemptAt ?? ''}\t${row.lastReasonCode ?? ''}`);
      }
    }, { migrate: true });
    return;
  }

  const id = args.positionals[0];
  if (!id) throw new Error(`usage: sigil federation outbox ${action} <id> [--database-url url]`);

  if (action === 'show') {
    await withRepository(args, requireMsg, async (repository) => {
      const record = await repository.getFederationOutboxRow(id);
      if (!record) {
        console.error(`No federation_outbox row for "${id}".`);
        process.exitCode = 1;
        return;
      }
      const { envelope, senderKey, ...meta } = record;
      console.log(JSON.stringify(meta, null, 2));
    }, { migrate: true });
    return;
  }

  await withRepository(args, requireMsg, async (repository) => {
    const result = await repository.retryFederationForward(id, new Date());
    if (result.retried) {
      console.log(`Re-queued ${id}`);
      return;
    }
    if (result.reason === 'MESSAGE_EXPIRED') {
      console.error(`Cannot retry ${id}: the stored envelope has expired — have the sender resend.`);
    } else {
      console.error(`Cannot retry ${id}: not in a retryable state (only forward_rejected / dead_letter rows can be re-queued).`);
    }
    process.exitCode = 1;
  }, { migrate: true });
}

// Read-only federation routing diagnostic. Sends NO envelope, ever: it only
// parses the recipient id, reads the local peer directory, GETs the peer
// relay's /v1/health, and prints an advisory same-owner-exemption line based
// on the local registry. The receiving relay always re-checks everything.
async function cmdRoute(argv) {
  const [action, ...rest] = argv;
  const usageLine = 'usage: sigil route test <recipient_federated_id> --identity <path> --relay-url <url> [--database-url url] [--registry path]';
  if (action !== 'test') throw new Error(usageLine);
  const args = parseArgs({ args: rest, options: { identity: { type: 'string' }, 'relay-url': { type: 'string' }, 'database-url': { type: 'string' }, registry: { type: 'string' } }, allowPositionals: true });
  const recipient = args.positionals[0];
  const identityPath = opt(args, ['identity']);
  const relayUrl = opt(args, ['relay-url']);
  if (!recipient || !identityPath || !relayUrl) throw new Error(usageLine);
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;

  // Step 1: parse the recipient federated id.
  const { parseFederatedId } = await import('../relay/v1/federated-id.mjs');
  let parsed;
  try {
    parsed = parseFederatedId(recipient);
  } catch (error) {
    console.error(`sigil route test: malformed recipient federated id "${recipient}" (${error.code ?? 'MALFORMED_FEDERATED_ID'}): ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Recipient: ${parsed.localPart}@${parsed.domain}`);

  // Step 2: resolve the recipient domain against the local peer directory.
  // With no database there is no durable peer directory, so every domain is
  // treated as unpinned.
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  let peer = null;
  if (databaseUrl) {
    // databaseUrl is non-empty in this branch, so withRepository's own
    // missing-url guard is never reached -- the message is intentionally empty.
    await withRepository(args, '', async (repository) => {
      peer = await repository.getPeerByDomain(parsed.domain);
    });
  }
  if (!peer) {
    console.log('Pinned: no');
    process.exitCode = 1;
    return;
  }
  console.log('Pinned: yes');
  console.log(`Peer relay URL: ${peer.relayUrl}`);

  // Step 3: probe the pinned peer relay's health endpoint (read-only GET).
  const reach = await checkRelayConnectivity(peer.relayUrl);
  if (reach.ok) {
    console.log(`Reachable: yes (${reach.latencyMs}ms)`);
  } else {
    console.log(`Reachable: no (${reach.error})`);
  }

  // Step 4: advisory same-owner-exemption line. Only informative when the
  // recipient endpoint is present in the local registry -- the receiving
  // relay re-checks against its own registry regardless.
  const localRegistry = toRegistryMap(loadRegistryFile(registryPath));
  const recipientEntry = localRegistry.get(recipient);
  if (!recipientEntry) {
    console.log('Same-owner exemption: not determinable locally');
  } else if (recipientEntry.owner_id === loadIdentity(identityPath).owner_id) {
    console.log('Same-owner exemption: would apply (advisory)');
  } else {
    console.log('Same-owner exemption: would NOT apply (advisory) — owner ids differ');
  }
  console.log('(advisory only — the receiving relay re-checks against its own registry)');
}

export async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  try {
    if (command === 'init') await cmdInit(process.argv.slice(3));
    else if (command === 'sign-contract') await cmdSignContract(process.argv.slice(3));
    else if (command === 'verify-contract') await cmdVerifyContract(process.argv.slice(3));
    else if (command === 'relay' && sub === 'up') await cmdRelayUp(rest);
    else if (command === 'oidc-issuer' && sub === 'add') await cmdOidcIssuerAdd(rest);
    else if (command === 'oidc-issuer' && sub === 'list') await cmdOidcIssuerList(rest);
    else if (command === 'oidc-issuer' && sub === 'remove') await cmdOidcIssuerRemove(rest);
    else if (command === 'peer' && sub === 'resolve') await cmdPeerResolve(rest);
    else if (command === 'peer' && sub === 'add') await cmdPeerAdd(rest);
    else if (command === 'peer' && sub === 'list') await cmdPeerList(rest);
    else if (command === 'peer' && sub === 'get') await cmdPeerGet(rest);
    else if (command === 'peer' && sub === 'remove') await cmdPeerRemove(rest);
    else if (command === 'peer' && sub === 'rotate') await cmdPeerRotate(rest);
    else if (command === 'peer' && sub === 'validate-document') await cmdPeerValidateDocument(rest);
    else if (command === 'agent' && sub === 'run') await cmdAgentRun(rest);
    else if (command === 'doctor') await cmdDoctor(process.argv.slice(3));
    else if (command === 'send') await cmdSend(process.argv.slice(3));
    else if (command === 'inbox') await cmdInbox(process.argv.slice(3));
    else if (command === 'federation') await cmdFederation(process.argv.slice(3));
    else if (command === 'route') await cmdRoute(process.argv.slice(3));
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
