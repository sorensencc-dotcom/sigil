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
import { resolveRateLimits } from '../relay/v1/relay-config.mjs';

const DEFAULT_CLI_CONFIG = path.join('.sigil', 'config.json');

const DEFAULT_REGISTRY = path.join('.sigil', 'registry.json');

function usage() {
  console.log(`sigil <command> [options]

Commands:
  init <name> [--owner <owner_id> | --federation-owner <federated_id>] [--registry path] [--domain domain]      Create a local identity and register it (domain defaults to "local"; --federation-owner allows an owner id whose domain differs from --domain)
  sign-contract --contract path --identity path [--output path]          Sign a TorqueQuery agent dispatch contract
  verify-contract --contract path --registry path                        Verify a signed TorqueQuery agent dispatch contract
  relay up [--registry path] [--port N] [--enable-mock-oidc] [--oidc-issuer-refresh-interval-ms N] [--domain domain] [--federation-mode sync|queue] [--federation-identity path] [--relay-request-freshness-ms N] Run a local relay (blocks; Ctrl+C to stop)
  relay well-known generate --identity path --domain domain --endpoint url [--ws-endpoint url] [--output path]
                                                            Emit this relay's .well-known/sigil discovery document from a designated endpoint identity
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
  federation invite create --peer <domain> --endpoint <fid> --identity <path> [--ttl 24h] [--database-url url]
                                                            Mint a redemption code for a peer domain; prints the code once, then the bare link_ref
  federation invite list [--database-url url]              List directory invites: link_ref, peer_domain, status, expires_at (never the code)
  federation invite revoke <link_ref> [--database-url url] Revoke a pending directory invite
  federation invite redeem <code> --identity <path> [--database-url url]
                                                            Redeem a peer's invite code, synchronously if reachable (else queued for retry)
  federation link list [--status s] [--database-url url]   List federation_directory_links rows: link_ref, role, owners, status, confirmation timestamps
  federation link show <link_ref> [--database-url url]     Show one federation_directory_links row (no hash, no code)
  federation link confirm <link_ref> --identity <path> [--database-url url]
                                                            Issuer-side explicit confirmation of a pending link (the redeemer side auto-confirms at redemption)
  federation link revoke <link_ref> --identity <path> [--database-url url]
                                                            Revoke a pending or active link from either side
  route test <recipient_federated_id> --identity path [--database-url url] [--registry path]
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
  const args = parseArgs({ args: argv, options: { registry: { type: 'string' }, port: { type: 'string' }, 'stream-port': { type: 'string' }, 'database-url': { type: 'string' }, 'enable-mock-oidc': { type: 'boolean' }, 'oidc-issuer-refresh-interval-ms': { type: 'string' }, domain: { type: 'string' }, 'federation-mode': { type: 'string' }, 'federation-identity': { type: 'string' }, 'relay-request-freshness-ms': { type: 'string' } } });
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
  // Inbound relay-request freshness window (signed_at skew tolerance). Flag
  // beats env beats the built-in default; `resolveRelayRequestFreshnessMs`
  // clamps to [60s, 1h] and falls back to 300s for anything unparseable. An
  // empty string from either source counts as "unset" rather than 0, which
  // would otherwise clamp up to the 60s floor and silently narrow the window.
  const relayRequestFreshnessMsRaw =
    opt(args, ['relay-request-freshness-ms'])
    ?? (process.env.SIGIL_RELAY_REQUEST_FRESHNESS_MS || undefined);
  const relayRequestFreshnessMs =
    relayRequestFreshnessMsRaw === undefined || relayRequestFreshnessMsRaw === ''
      ? undefined
      : Number(relayRequestFreshnessMsRaw);
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
  if (!data.endpoints.length) throw new Error(`No endpoints in ${registryPath}. Run "sigil init <name> --owner <owner_id>" (or --federation-owner <federated_id>) first.`);
  if (relayDomain !== undefined && !data.endpoints.some((ep) => isLocalDomain(ep.endpoint_id, relayDomain))) {
    console.log(`WARNING: no endpoint in ${registryPath} belongs to domain "${relayDomain}" -- every envelope will be rejected with RECIPIENT_NOT_LOCAL. Register an endpoint with "sigil init <name> --owner <owner_id> --domain ${relayDomain}" (or --federation-owner <federated_id> for an owner whose domain differs from --domain), or drop --domain.`);
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
  server = createRelayServer({ registry, repository, tokenHashes, stream, relayOrigin, enableMockOidc, oidcIssuerAllowList, relayDomain, federationMode, federationIdentity, relayRequestFreshnessMs });
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

const RELAY_WELL_KNOWN_USAGE =
  'usage: sigil relay well-known generate --identity path --domain domain --endpoint url [--ws-endpoint url] [--output path]';

async function cmdRelayWellKnown(argv) {
  if (argv[0] !== 'generate') throw new Error(RELAY_WELL_KNOWN_USAGE);
  const args = parseArgs({
    args: argv.slice(1),
    options: {
      identity: { type: 'string' },
      domain: { type: 'string' },
      endpoint: { type: 'string' },
      'ws-endpoint': { type: 'string' },
      output: { type: 'string' },
    },
  });
  const identityPath = opt(args, ['identity']);
  const domain = opt(args, ['domain']);
  const endpoint = opt(args, ['endpoint']);
  const wsEndpoint = opt(args, ['ws-endpoint']);
  const outputPath = opt(args, ['output']);
  if (!identityPath || !domain || !endpoint) throw new Error(RELAY_WELL_KNOWN_USAGE);

  await requireValidPeerDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else

  const identity = loadIdentity(identityPath);
  const { buildPeerDocument } = await import('../relay/v1/well-known-document.mjs');
  const { validatePeerDocument } = await import('../relay/v1/peer-discovery.mjs');
  const { isLocalDomain } = await import('../relay/v1/federated-id.mjs');

  const doc = buildPeerDocument({ identity, domain, endpoint, wsEndpoint });

  // Non-blocking consistency warnings -- the consumer's validatePeerDocument
  // checks none of these cross-field relationships, so a document that routes
  // trust to a host other than the one it is published under would otherwise
  // pass silently.
  const hostOf = (url) => {
    try { return new URL(url).host; } catch { return null; }
  };
  const endpointHost = hostOf(endpoint);
  if (endpointHost && endpointHost !== domain) {
    console.error(`WARNING: --endpoint host "${endpointHost}" does not match --domain "${domain}"`);
  }
  const wsHost = wsEndpoint ? hostOf(wsEndpoint) : null;
  if (wsHost && wsHost !== domain) {
    console.error(`WARNING: --ws-endpoint host "${wsHost}" does not match --domain "${domain}"`);
  }
  if (identity.endpoint_id && !isLocalDomain(identity.endpoint_id, domain)) {
    console.error(`WARNING: identity endpoint "${identity.endpoint_id}" does not belong to domain "${domain}"`);
  }

  // Refuse to emit a document this repo's own discovery consumer would reject.
  validatePeerDocument(doc, { expectedDomain: domain });

  const serialized = JSON.stringify(doc, null, 2) + '\n';
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, outputPath); // atomic replace on POSIX and on Windows (MoveFileEx)
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
  console.error(`wrote ${outputPath} -- verify with: sigil peer validate-document ${outputPath}`);
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

// `sigil federation <outbox|invite|link>` -- dispatch on group. `outbox`
// inspects/re-queues queue-mode federation forward jobs; `invite` is the
// operator on-ramp for minting/redeeming cross-federation directory invite
// codes (Task 13); `link` (Task 14) manages the resulting
// federation_directory_links rows: list/show them and drive the issuer-side
// confirm/revoke transitions (redemption itself, and the redeemer's implicit
// confirmation, both happen in `invite redeem`/Task 13).
async function cmdFederation(argv) {
  const [group, action, ...rest] = argv;
  if (group === 'outbox') return cmdFederationOutbox(action, rest);
  if (group === 'invite') return cmdFederationInvite(action, rest);
  if (group === 'link') return cmdFederationLink(action, rest);
  throw new Error('usage: sigil federation <outbox|invite|link> ...');
}

// `sigil federation outbox list|show|retry` -- inspect and re-queue the
// queue-mode federation forward jobs in federation_outbox (Task 13 repo
// methods). Never prints an envelope body: `list` rows are already
// body-stripped by listFederationOutbox; `show` omits envelope/senderKey
// before printing.
async function cmdFederationOutbox(action, rest) {
  const actions = ['list', 'show', 'retry'];
  if (!actions.includes(action)) {
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
      // Strip the envelope body, the propagated sender key, the internal lease
      // fields (claim token / claimed-at), and the directory payload (a
      // redemption row's payload historically carried the plaintext
      // `sigil-fed-invite:` code) -- none belong in operator output.
      const { envelope, senderKey, claimToken, claimedAt, directoryPayload, ...meta } = record;
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

// `sigil federation invite create|list|revoke|redeem` -- the operator
// on-ramp for the cross-federation directory (design §"New CLI: sigil
// federation invite"). `create`/`redeem` bind the acting operator to a
// specific local endpoint via `--identity <path>`, the CLI's equivalent of
// "an authenticated human session whose owner equals X" (same role
// `--identity` plays in `sigil route test`).
async function cmdFederationInvite(action, rest) {
  const actions = ['create', 'list', 'revoke', 'redeem'];
  if (!actions.includes(action)) {
    throw new Error('usage: sigil federation invite <create|list|revoke|redeem> ...');
  }
  if (action === 'create') return cmdFederationInviteCreate(rest);
  if (action === 'list') return cmdFederationInviteList(rest);
  if (action === 'revoke') return cmdFederationInviteRevoke(rest);
  return cmdFederationInviteRedeem(rest);
}

const ONE_HOUR_MS = 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;

// Parses `30m` / `24h` / `7d` style durations and clamps to [1h, 7d]
// (design default: 24h). No unit -> error rather than silently guessing.
function parseInviteTtlMs(raw) {
  if (raw == null) return 24 * ONE_HOUR_MS;
  const match = /^([0-9]+)(s|m|h|d)$/.exec(String(raw).trim());
  if (!match) throw new Error(`sigil federation invite create: invalid --ttl "${raw}" (expected e.g. "30m", "24h", "7d")`);
  const unitMs = { s: 1000, m: 60_000, h: ONE_HOUR_MS, d: 24 * ONE_HOUR_MS }[match[2]];
  const ms = Number(match[1]) * unitMs;
  return Math.min(Math.max(ms, ONE_HOUR_MS), SEVEN_DAYS_MS);
}

const INVITE_CREATE_USAGE = 'usage: sigil federation invite create --peer <domain> --endpoint <federated-id> --identity <path> [--ttl <duration>] [--domain <domain>] [--registry <path>] [--database-url url]';

async function cmdFederationInviteCreate(rest) {
  const args = parseArgs({
    args: rest,
    options: {
      peer: { type: 'string' },
      endpoint: { type: 'string' },
      identity: { type: 'string' },
      domain: { type: 'string' },
      ttl: { type: 'string' },
      registry: { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  const peerDomain = opt(args, ['peer']);
  const endpoint = opt(args, ['endpoint']);
  const identityPath = opt(args, ['identity']);
  if (!peerDomain || !endpoint || !identityPath) throw new Error(INVITE_CREATE_USAGE);

  const { parseDomain, parseFederatedId } = await import('../relay/v1/federated-id.mjs');
  parseDomain(peerDomain);
  const parsedEndpoint = parseFederatedId(endpoint);

  // This relay's own domain: an explicit --domain wins; otherwise it is read
  // off the endpoint being introduced (the endpoint IS hosted on this relay,
  // by construction of the check right below). Either way the endpoint's
  // domain must equal it -- an operator cannot mint an invite that names an
  // endpoint on someone else's relay.
  const relayDomain = opt(args, ['domain']) ?? parsedEndpoint.domain;
  if (relayDomain !== parsedEndpoint.domain) {
    throw new Error(`sigil federation invite create: --domain "${relayDomain}" does not match --endpoint domain "${parsedEndpoint.domain}"`);
  }

  // Actor binding: --identity must be the human session that owns --endpoint,
  // per the local registry (same source of truth "sigil route test" reads for
  // its advisory same-owner-exemption line).
  const identity = loadIdentity(identityPath);
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const registryEntry = toRegistryMap(loadRegistryFile(registryPath)).get(endpoint);
  if (!registryEntry || registryEntry.owner_id !== identity.owner_id) {
    throw new Error(`sigil federation invite create: --identity must own the endpoint "${endpoint}"`);
  }

  const ttlMs = parseInviteTtlMs(opt(args, ['ttl']));
  const requireMsg = 'sigil federation invite create requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory invites';
  await withRepository(args, requireMsg, async (repository) => {
    const now = new Date();

    // (rate) Load-bearing invite-mint abuse scope, keyed per issuer endpoint+owner.
    if (typeof repository.reserveRateLimit === 'function') {
      const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
      const limit = resolveRateLimits().federation_directory_invite_create;
      const reservation = await repository.reserveRateLimit('federation_directory_invite_create', `${endpoint}:${identity.owner_id}`, windowStart, limit);
      if (reservation && reservation.allowed === false) {
        throw new Error('invite-create rate limit reached');
      }
    }

    const linkRef = crypto.randomUUID();
    const segment = crypto.randomBytes(24).toString('base64url');
    const codeHash = crypto.createHash('sha256').update(segment).digest('hex');
    const expiresAt = new Date(now.getTime() + ttlMs);
    await repository.createFederationDirectoryInvite({
      linkRef,
      issuerEndpointId: endpoint,
      issuerOwnerId: identity.owner_id,
      peerDomain,
      codeHash,
      expiresAt,
      now,
    });
    await repository.recordAuditEvent({
      eventType: 'federation_directory.invite_created',
      subjectId: linkRef,
      actorId: identity.owner_id,
      endpointId: endpoint,
      objectType: 'federation_directory_invite',
      objectId: linkRef,
      outcome: 'accepted',
      payload: { peer_domain: peerDomain },
      now,
    });
    // The full redemption code is printed exactly once -- only the sha256 of
    // its segment is ever persisted (createFederationDirectoryInvite above).
    // The second, bare link_ref line lets an operator grab just the id (e.g.
    // for `sigil federation invite revoke`) without re-parsing the code line.
    console.log(`sigil-fed-invite:${relayDomain}:${linkRef}:${segment}`);
    console.log(linkRef);
  }, { migrate: true });
}

async function cmdFederationInviteList(rest) {
  const args = parseArgs({ args: rest, options: { 'database-url': { type: 'string' } } });
  const requireMsg = 'sigil federation invite list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory invites';
  await withRepository(args, requireMsg, async (repository) => {
    const rows = await repository.listFederationDirectoryInvites({});
    for (const row of rows) {
      console.log(`${row.link_ref}\t${row.peer_domain}\t${row.status}\t${row.expires_at}`);
    }
  }, { migrate: true });
}

async function cmdFederationInviteRevoke(rest) {
  const args = parseArgs({ args: rest, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const linkRef = args.positionals[0];
  if (!linkRef) throw new Error('usage: sigil federation invite revoke <link_ref> [--database-url url]');
  const requireMsg = 'sigil federation invite revoke requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory invites';
  await withRepository(args, requireMsg, async (repository) => {
    const now = new Date();
    const result = await repository.revokeFederationDirectoryInvite(linkRef, now);
    if (result.updated) {
      await repository.recordAuditEvent({
        eventType: 'federation_directory.invite_revoked',
        subjectId: linkRef,
        objectType: 'federation_directory_invite',
        objectId: linkRef,
        outcome: 'accepted',
        payload: {},
        now,
      });
      console.log(`Revoked invite ${linkRef}.`);
      return;
    }
    const invite = await repository.getFederationDirectoryInviteByRef(linkRef);
    if (!invite) {
      console.error(`No invite for link_ref "${linkRef}".`);
    } else if (invite.status === 'redeemed') {
      console.error('already redeemed — use `sigil federation link revoke <link_ref>`');
    } else {
      console.error(`already ${invite.status}`);
    }
    process.exitCode = 1;
  }, { migrate: true });
}

const INVITE_REDEEM_USAGE = 'usage: sigil federation invite redeem <code> --identity <path> [--database-url url]';

// Synchronous redemption (locked design decision (b)): POST to the issuer
// relay and wait. A 202 lets us write the redeemer's federation_directory_links
// row fully populated right away (we now know the issuer's identity from the
// response body). A terminal 4xx writes nothing.
//
// A transport failure / 5xx writes nothing and is NOT retried: there is no
// durable-outbox fallback for a redemption, because a `directory_redemption`
// outbox row would have to persist the plaintext invite code in
// `directory_payload` (Q4). The operator re-runs the command instead. Do not
// reintroduce the fallback -- it leaks the code at rest.
async function cmdFederationInviteRedeem(rest) {
  const args = parseArgs({
    args: rest,
    options: { identity: { type: 'string' }, endpoint: { type: 'string' }, 'database-url': { type: 'string' } },
    allowPositionals: true,
  });
  const code = args.positionals[0];
  const identityPath = opt(args, ['identity']);
  if (!code || !identityPath) throw new Error(INVITE_REDEEM_USAGE);

  const parts = code.split(':');
  if (parts.length !== 4 || parts[0] !== 'sigil-fed-invite') {
    throw new Error('sigil federation invite redeem: code is not sigil-fed-invite:<domain>:<link_ref>:<segment>');
  }
  const [, issuerDomain, linkRef] = parts;
  const { parseDomain } = await import('../relay/v1/federated-id.mjs');
  parseDomain(issuerDomain);

  const identity = loadIdentity(identityPath);
  const endpointOverride = opt(args, ['endpoint']);
  if (endpointOverride !== undefined && endpointOverride !== identity.endpoint_id) {
    throw new Error("sigil federation invite redeem: --endpoint must match --identity's own endpoint_id");
  }
  const redeemer = { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id };
  const { parseFederatedId } = await import('../relay/v1/federated-id.mjs');
  const redeemerDomain = parseFederatedId(identity.endpoint_id).domain;

  const requireMsg = 'sigil federation invite redeem requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory links';
  await withRepository(args, requireMsg, async (repository) => {
    const peer = await repository.getPeerByDomain(issuerDomain);
    if (!peer) {
      console.error(`pin the peer relay first: sigil peer resolve --domain ${issuerDomain}`);
      process.exitCode = 1;
      return;
    }

    const { buildRedemptionRequest, signRelayRequest, postDirectory, assertIssuerResponseIdentity } = await import('../relay/v1/federation-directory-client.mjs');
    const now = new Date();
    const { canonicalBytes } = buildRedemptionRequest({ linkRef, code, redeemer, redeemerDomain, now });
    const signed = signRelayRequest(canonicalBytes, identity);

    let outcome;
    try {
      outcome = await postDirectory(peer, '/v1/federation/directory/redemptions', canonicalBytes, signed);
    } catch (error) {
      if (error && error.code === 'FORWARD_TRANSPORT_FAILED') {
        // Do NOT enqueue a durable federation_outbox retry row here: its
        // directory_payload carries the plaintext invite code (Q4). The
        // redemption is cheap to re-drive by hand, so ask the operator to
        // re-run the command once the issuer relay is reachable again.
        console.error(`issuer relay unreachable; re-run 'sigil federation invite redeem ${code}' when it is back`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (outcome.ok) {
      const issuer = outcome.body?.issuer;
      if (issuer && issuer.owner_id && issuer.endpoint_id) {
        // (E2) Do not trust the issuer relay's self-description: its 202 must
        // name an owner/endpoint that are well-formed federated ids on its own
        // domain. Reject before reserving quota or writing the link row.
        try {
          assertIssuerResponseIdentity(issuer, issuerDomain);
        } catch (err) {
          if (err?.code !== 'ISSUER_IDENTITY_DOMAIN_MISMATCH') throw err;
          await repository.recordAuditEvent({
            eventType: 'federation_directory.invite_redeem_rejected',
            subjectId: linkRef, actorId: redeemer.owner_id, endpointId: redeemer.endpoint_id,
            objectType: 'federation_directory_invite', objectId: linkRef,
            outcome: 'rejected', reason: 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
            payload: { peer_domain: issuerDomain }, now,
          });
          console.error(`sigil federation invite redeem: issuer relay response names an owner/endpoint outside ${issuerDomain}; refusing to write the link`);
          process.exitCode = 1;
          return;
        }
        // (rate) Load-bearing redeem-attempt abuse scope, keyed per redeemer
        // endpoint+owner. Placed here -- after the peer-pinned check has
        // passed and the outbound POST has come back accepted -- so an
        // unpinned-peer error or a transport failure (both return before
        // reaching this branch) never consumes the redeemer's own quota;
        // only a redemption that actually clears and is about to write the
        // local link row does.
        if (typeof repository.reserveRateLimit === 'function') {
          const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
          const limit = resolveRateLimits().federation_directory_redeem;
          const reservation = await repository.reserveRateLimit('federation_directory_redeem', `${redeemer.endpoint_id}:${redeemer.owner_id}`, windowStart, limit);
          if (reservation && reservation.allowed === false) {
            throw new Error('invite-redeem rate limit reached');
          }
        }
        try {
          await repository.createFederationDirectoryLink({
            linkRef,
            localOwnerId: redeemer.owner_id,
            localEndpointId: redeemer.endpoint_id,
            remoteOwnerId: issuer.owner_id,
            remoteEndpointId: issuer.endpoint_id,
            remoteDomain: issuerDomain,
            role: 'redeemer',
            initiatedVia: redeemer.owner_id === issuer.owner_id ? 'self_pair' : 'invite',
            status: 'pending',
            localConfirmedAt: now,
            remoteConfirmedAt: null,
            sourceInviteId: null,
            peerDomain: issuerDomain,
          });
        } catch (error) {
          // Idempotent: a prior reaper pass (or a retried redeem) already wrote it.
          if (!error || error.code !== 'FEDERATION_LINK_EXISTS') throw error;
        }
      }
      await repository.recordAuditEvent({
        eventType: 'federation_directory.invite_redeemed',
        subjectId: linkRef,
        actorId: redeemer.owner_id,
        endpointId: redeemer.endpoint_id,
        objectType: 'federation_directory_invite',
        objectId: linkRef,
        outcome: 'accepted',
        payload: { peer_domain: issuerDomain },
        now,
      });
      console.log(linkRef);
      console.log('waiting for issuer confirmation.');
      return;
    }

    console.error(`sigil federation invite redeem: redemption rejected by issuer relay (${outcome.peerCode ?? outcome.status})`);
    process.exitCode = 1;
  }, { migrate: true });
}

// `sigil federation link list|show|confirm|revoke` -- operates on
// federation_directory_links rows created by `invite redeem`/the reaper
// (Tasks 11/13). `list`/`show` never print a hash or code segment -- there
// is none on this table (those live only on federation_directory_invites).
// `confirm`/`revoke` synthesise the outbox row's message_id/idempotency_key
// from the parsed link_ref, matching the (linkRef, linkRef) /
// (linkRef, linkRef + ':confirm') / (linkRef, linkRef + ':revoke')
// convention Task 13's redemption path already uses.
async function cmdFederationLink(action, rest) {
  const actions = ['list', 'show', 'confirm', 'revoke'];
  if (!actions.includes(action)) {
    throw new Error('usage: sigil federation link <list|show|confirm|revoke> ...');
  }
  if (action === 'list') return cmdFederationLinkList(rest);
  if (action === 'show') return cmdFederationLinkShow(rest);
  if (action === 'confirm') return cmdFederationLinkConfirm(rest);
  return cmdFederationLinkRevoke(rest);
}

async function cmdFederationLinkList(rest) {
  const args = parseArgs({ args: rest, options: { status: { type: 'string' }, 'database-url': { type: 'string' } } });
  const requireMsg = 'sigil federation link list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory links';
  await withRepository(args, requireMsg, async (repository) => {
    const status = opt(args, ['status']);
    const rows = await repository.listFederationDirectoryLinks(status ? { status } : {});
    for (const row of rows) {
      console.log(`${row.link_ref}\t${row.role}\t${row.local_owner_id}\t${row.remote_owner_id}@${row.remote_domain}\t${row.status}\t${row.local_confirmed_at ?? ''}\t${row.remote_confirmed_at ?? ''}`);
    }
  }, { migrate: true });
}

async function cmdFederationLinkShow(rest) {
  const args = parseArgs({ args: rest, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const linkRef = args.positionals[0];
  if (!linkRef) throw new Error('usage: sigil federation link show <link_ref> [--database-url url]');
  const requireMsg = 'sigil federation link show requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory links';
  await withRepository(args, requireMsg, async (repository) => {
    const row = await repository.getFederationDirectoryLinkByRef(linkRef);
    if (!row) {
      console.error(`No federation directory link for "${linkRef}".`);
      process.exitCode = 1;
      return;
    }
    console.log(`link_ref\t${row.link_ref}`);
    console.log(`role\t${row.role}`);
    console.log(`local_owner_id\t${row.local_owner_id}`);
    console.log(`local_endpoint_id\t${row.local_endpoint_id}`);
    console.log(`remote_owner_id\t${row.remote_owner_id}`);
    console.log(`remote_endpoint_id\t${row.remote_endpoint_id}`);
    console.log(`remote_domain\t${row.remote_domain}`);
    console.log(`status\t${row.status}`);
    console.log(`local_confirmed_at\t${row.local_confirmed_at ?? ''}`);
    console.log(`remote_confirmed_at\t${row.remote_confirmed_at ?? ''}`);
    console.log(`revoked_at\t${row.revoked_at ?? ''}`);
    console.log(`revoked_by\t${row.revoked_by ?? ''}`);
    console.log(`last_reason_code\t${row.last_reason_code ?? ''}`);
    // Transition history would come from an audit-event query keyed on
    // subject_id; the repository does not yet expose one (only
    // listAuditEventsForConversation, keyed on conversation_id, exists), so
    // print the row only rather than guess at a shape.
    if (typeof repository.listAuditEvents === 'function') {
      const events = await repository.listAuditEvents({ subjectId: linkRef });
      console.log('\nhistory:');
      for (const event of events) {
        console.log(`${event.created_at}\t${event.event_type}\t${event.outcome ?? ''}`);
      }
    } else {
      console.log('\n(transition history needs an audit-event query by subject id, not yet exposed by the repository)');
    }
  }, { migrate: true });
}

const LINK_CONFIRM_USAGE = 'usage: sigil federation link confirm <link_ref> --identity <path> [--database-url url]';

async function cmdFederationLinkConfirm(rest) {
  const args = parseArgs({
    args: rest,
    options: { identity: { type: 'string' }, 'database-url': { type: 'string' } },
    allowPositionals: true,
  });
  const linkRef = args.positionals[0];
  const identityPath = opt(args, ['identity']);
  if (!linkRef || !identityPath) throw new Error(LINK_CONFIRM_USAGE);
  const identity = loadIdentity(identityPath);

  const requireMsg = 'sigil federation link confirm requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory links';
  await withRepository(args, requireMsg, async (repository) => {
    const row = await repository.getFederationDirectoryLinkByRef(linkRef);
    if (!row) {
      console.error(`No federation directory link for "${linkRef}".`);
      process.exitCode = 1;
      return;
    }
    if (row.role === 'redeemer') {
      console.error('sigil federation link confirm: redeemer side auto-confirmed at redemption');
      process.exitCode = 1;
      return;
    }
    if (row.status !== 'pending') {
      console.error('sigil federation link confirm: link is already revoked/terminal; nothing enqueued');
      process.exitCode = 1;
      return;
    }
    if (identity.owner_id !== row.local_owner_id) {
      console.error('sigil federation link confirm: --identity is not the link owner');
      process.exitCode = 1;
      return;
    }

    const now = new Date();
    const result = await repository.setFederationDirectoryLinkConfirmation(linkRef, 'local', now);
    if (!result.updated) {
      console.error('sigil federation link confirm: link is already revoked/terminal; nothing enqueued');
      process.exitCode = 1;
      return;
    }

    if (typeof repository.enqueueFederationForward === 'function') {
      const { parseFederatedId } = await import('../relay/v1/federated-id.mjs');
      // Store only { link_ref }; the reaper rebuilds the signed confirmation
      // request (fresh nonce + signed_at) on every pass.
      await repository.enqueueFederationForward({
        kind: 'directory_confirmation',
        messageId: linkRef,
        idempotencyKey: `${linkRef}:confirm`,
        recipientDomain: row.remote_domain,
        originDomain: parseFederatedId(identity.endpoint_id).domain,
        directoryPayload: { link_ref: linkRef },
        now,
      });
    }

    await repository.recordAuditEvent({
      eventType: 'federation_directory.link_confirmed',
      subjectId: linkRef,
      actorId: identity.owner_id,
      endpointId: identity.endpoint_id,
      objectType: 'federation_directory_link',
      objectId: linkRef,
      outcome: 'accepted',
      payload: {},
      now,
    });
    if (result.activated) {
      await repository.recordAuditEvent({
        eventType: 'federation_directory.link_activated',
        subjectId: linkRef,
        actorId: identity.owner_id,
        endpointId: identity.endpoint_id,
        objectType: 'federation_directory_link',
        objectId: linkRef,
        outcome: 'accepted',
        payload: {},
        now,
      });
    }
    console.log('Confirmed; peer notification enqueued.');
  }, { migrate: true });
}

const LINK_REVOKE_USAGE = 'usage: sigil federation link revoke <link_ref> --identity <path> [--database-url url]';

async function cmdFederationLinkRevoke(rest) {
  const args = parseArgs({
    args: rest,
    options: { identity: { type: 'string' }, 'database-url': { type: 'string' } },
    allowPositionals: true,
  });
  const linkRef = args.positionals[0];
  const identityPath = opt(args, ['identity']);
  if (!linkRef || !identityPath) throw new Error(LINK_REVOKE_USAGE);
  const identity = loadIdentity(identityPath);

  const requireMsg = 'sigil federation link revoke requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable directory links';
  await withRepository(args, requireMsg, async (repository) => {
    const row = await repository.getFederationDirectoryLinkByRef(linkRef);
    if (!row) {
      console.error(`No federation directory link for "${linkRef}".`);
      process.exitCode = 1;
      return;
    }
    if (identity.owner_id !== row.local_owner_id) {
      console.error('sigil federation link revoke: --identity is not the link owner');
      process.exitCode = 1;
      return;
    }

    const now = new Date();
    const result = await repository.revokeFederationDirectoryLink(linkRef, 'local', now);
    if (!result.updated) {
      console.error('sigil federation link revoke: already revoked');
      process.exitCode = 1;
      return;
    }

    if (typeof repository.enqueueFederationForward === 'function') {
      const { parseFederatedId } = await import('../relay/v1/federated-id.mjs');
      // Store only { link_ref }; the reaper rebuilds the signed revocation
      // request (fresh nonce + signed_at) on every pass.
      await repository.enqueueFederationForward({
        kind: 'directory_revocation',
        messageId: linkRef,
        idempotencyKey: `${linkRef}:revoke`,
        recipientDomain: row.remote_domain,
        originDomain: parseFederatedId(identity.endpoint_id).domain,
        directoryPayload: { link_ref: linkRef },
        now,
      });
    }

    await repository.recordAuditEvent({
      eventType: 'federation_directory.link_revoked',
      subjectId: linkRef,
      actorId: identity.owner_id,
      endpointId: identity.endpoint_id,
      objectType: 'federation_directory_link',
      objectId: linkRef,
      outcome: 'accepted',
      payload: { by: 'local' },
      now,
    });
    console.log('Revoked; peer notification enqueued.');
  }, { migrate: true });
}

// Read-only federation routing diagnostic. Sends NO envelope, ever: it only
// parses the recipient id, reads the local peer directory, GETs the peer
// relay's /v1/health, and prints an advisory same-owner-exemption line based
// on the local registry. The receiving relay always re-checks everything.
async function cmdRoute(argv) {
  const [action, ...rest] = argv;
  const usageLine = 'usage: sigil route test <recipient_federated_id> --identity <path> [--database-url url] [--registry path]';
  if (action !== 'test') throw new Error(usageLine);
  const args = parseArgs({ args: rest, options: { identity: { type: 'string' }, 'database-url': { type: 'string' }, registry: { type: 'string' } }, allowPositionals: true });
  const recipient = args.positionals[0];
  const identityPath = opt(args, ['identity']);
  if (!recipient || !identityPath) throw new Error(usageLine);
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
    process.exitCode = 1;
  }

  // Step 4: resolve the recipient's owner from the local registry, which is
  // what the directory-link lookup below needs. The receiving relay re-checks
  // against its own registry regardless.
  const localRegistry = toRegistryMap(loadRegistryFile(registryPath));
  // Look up by the normalized federated id (localPart@domain), not the raw CLI
  // arg -- the registry is keyed on the canonical form printed above.
  const recipientEntry = localRegistry.get(`${parsed.localPart}@${parsed.domain}`);
  const identity = loadIdentity(identityPath);
  console.log('(advisory only — the receiving relay re-checks against its own registry)');

  // Step 5: advisory directory-link line. EVERY federated delivery needs an
  // active directory link, including a same-owner pair: B1 removed the
  // same-owner exemption, so an owner federating with itself must hold a
  // self-pair link like anyone else. Requires a database, since the directory
  // only exists in PostgreSQL. `route test` only has the recipient's federated
  // id, not its owner, so this can only run when the local registry resolved
  // the recipient entry above; without that, the recipient owner is not
  // derivable here.
  if (peer) {
    if (!databaseUrl) {
      // No database, so no durable directory to consult either way.
    } else if (!recipientEntry) {
      console.log('Directory link: not determinable locally');
    } else {
      await withRepository(args, '', async (repository) => {
        const link = await repository.getActiveFederationDirectoryLink(identity.owner_id, recipientEntry.owner_id, parsed.domain);
        if (link) console.log(`Directory link: active (link_ref ${link.link_ref})`);
        else console.log('Directory link: none — delivery would be DIRECTORY_LINK_REQUIRED');
      });
    }
  }
}

export async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  try {
    if (command === 'init') await cmdInit(process.argv.slice(3));
    else if (command === 'sign-contract') await cmdSignContract(process.argv.slice(3));
    else if (command === 'verify-contract') await cmdVerifyContract(process.argv.slice(3));
    else if (command === 'relay' && sub === 'up') await cmdRelayUp(rest);
    else if (command === 'relay' && sub === 'well-known') await cmdRelayWellKnown(rest);
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
