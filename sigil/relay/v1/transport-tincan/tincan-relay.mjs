import crypto from 'node:crypto';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BRIDGES, createWakeDispatcher } from './wake-dispatcher.mjs';
import { createHeldQueue } from './held-queue.mjs';
import { verifyTailscaleWhoIs } from './whois-auth.mjs';
import { dispatchDeliveryWithRetry } from './dispatch-lifecycle.mjs';
import { RelayClient } from '../../../connectors/v1/relay-client.mjs';

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 64 * 1024;
const DISPATCH_PATH = '/v1/dispatch';
const CALLBACK_PATH = '/v1/approval-callback';

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

export function normalizeRemoteAddress(address) {
  if (!address) return '';
  const zone = String(address).split('%')[0];
  return zone.startsWith('::ffff:') ? zone.slice('::ffff:'.length) : zone;
}

export function isLoopbackAddress(address) {
  const ip = normalizeRemoteAddress(address);
  return ip === '127.0.0.1' || ip === '::1';
}

function assertPeerAddress(address) {
  if (!/^[0-9a-fA-F:.]+$/.test(address) || address.length > 64) {
    throw refuse('UNAUTHORIZED_NODE', 'Connection is not from a Tailnet node');
  }
  return address;
}

function secretEqual(given, expected) {
  if (!expected || typeof given !== 'string' || given.length === 0) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length);
}

async function readBody(request, maxBytes) {
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw refuse('REQUEST_TOO_LARGE', 'Request body too large');
    raw += chunk;
  }
  return raw;
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  if (!response.headersSent) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  }
  response.end(payload);
}

function sendHtml(response, status, title, text) {
  const escape = (value) => String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1><p>${escape(text)}</p></body></html>`;
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
}

function pathnameOf(request) {
  return new URL(request.url, 'http://127.0.0.1').pathname;
}

export function createTailscaleWhoIs({ command = 'tailscale', execFileFn = execFileAsync } = {}) {
  return {
    async whois(remoteAddress) {
      const { stdout } = await execFileFn(command, ['whois', '--json', remoteAddress], { windowsHide: true, timeout: 8000 });
      return JSON.parse(stdout);
    },
  };
}

export async function loadTincanConfig(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.allowlist || !parsed.endpoints) {
    throw refuse('CONFIG_INVALID', 'Config must include allowlist and endpoints');
  }
  const allowlist = new Map();
  for (const [nodeKey, entry] of Object.entries(parsed.allowlist)) {
    if (!entry || !Array.isArray(entry.permitted_endpoints) || !Array.isArray(entry.allowed_host_roles)) {
      throw refuse('CONFIG_INVALID', `Allowlist entry ${nodeKey} is missing endpoint or role arrays`);
    }
    allowlist.set(nodeKey, { permitted_endpoints: entry.permitted_endpoints, allowed_host_roles: entry.allowed_host_roles });
  }
  const endpoints = new Map();
  for (const [endpointId, entry] of Object.entries(parsed.endpoints)) {
    if (!entry || !BRIDGES.has(entry.bridge_type) || typeof entry.identity_path !== 'string' || typeof entry.relay_url !== 'string') {
      throw refuse('CONFIG_INVALID', `Endpoint ${endpointId} needs bridge_type, identity_path, and relay_url`);
    }
    endpoints.set(endpointId, {
      bridgeType: entry.bridge_type,
      identityPath: entry.identity_path,
      relayUrl: entry.relay_url,
      sessionStore: entry.session_store ?? '.sigil/room-sessions.json',
    });
  }
  return { allowlist, endpoints };
}

export function createTincanRelay({
  allowlist, tailscale, dispatcher, heldQueue, failFn, callbackSecret, endpoints,
  onReleased, remoteAddressOf, sleepFn, nowFn, maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  if (typeof failFn !== 'function') throw refuse('CONFIG_INVALID', 'failFn is required');
  if (!callbackSecret) throw refuse('CONFIG_INVALID', 'callbackSecret is required');
  const challenges = new Map();
  const peerAddress = (request) => assertPeerAddress(normalizeRemoteAddress(
    remoteAddressOf ? remoteAddressOf(request) : request.socket?.remoteAddress,
  ));

  async function release(actionHash) {
    const envelope = heldQueue.releaseEnvelope(actionHash);
    for (const [challengeId, hash] of challenges) {
      if (hash === actionHash) challenges.delete(challengeId);
    }
    if (onReleased) await onReleased(envelope, actionHash);
    return envelope;
  }

  async function handleDispatch(request, response) {
    try {
      if (request.method !== 'POST' || pathnameOf(request) !== DISPATCH_PATH) {
        return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Not found' });
      }
      let body;
      try { body = JSON.parse(await readBody(request, maxBodyBytes)); }
      catch (error) {
        if (error.code === 'REQUEST_TOO_LARGE') return sendJson(response, 413, { code: error.code, message: error.message });
        return sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'Dispatch body must be JSON' });
      }
      const delivery = body?.delivery;
      const targetEndpoint = body?.target_endpoint;
      if (!delivery?.conversation_id || !delivery?.invocation_id || !targetEndpoint) {
        return sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'delivery.conversation_id, delivery.invocation_id, and target_endpoint are required' });
      }
      let whois;
      try {
        const remoteAddress = peerAddress(request);
        whois = await verifyTailscaleWhoIs({
          remoteAddress, senderEndpoint: body.sender_endpoint, targetEndpoint,
        }, allowlist, tailscale);
      } catch (error) {
        const code = typeof error.code === 'string' ? error.code : 'UNAUTHORIZED_NODE';
        return sendJson(response, 403, { code, message: error.message });
      }
      const hosted = endpoints.get(targetEndpoint);
      if (!hosted) return sendJson(response, 404, { code: 'ENDPOINT_NOT_HOSTED', message: `This host does not run ${targetEndpoint}` });
      // The peer names the endpoint. This host owns the identity file and bridge.
      const result = await dispatchDeliveryWithRetry({
        delivery,
        failFn,
        sleepFn,
        nowFn,
        wakeFn: async () => {
          const wake = await dispatcher.wakeAgent({
            endpointId: targetEndpoint,
            bridgeType: hosted.bridgeType,
            identityPath: hosted.identityPath,
            relayUrl: hosted.relayUrl,
            sessionStore: hosted.sessionStore,
          });
          return { status: 'DELIVERED', node: whois.machineName, ...wake };
        },
      });
      if (result.status === 'FAILED') return sendJson(response, 502, result);
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 502, { code: error.code ?? 'DISPATCH_FAILED', message: error.message });
    }
  }

  async function handleCallback(request, response) {
    try {
      if (pathnameOf(request) !== CALLBACK_PATH) {
        return sendJson(response, 404, { code: 'NOT_FOUND', message: 'Not found' });
      }
      // approval-ceremony.mjs rejects every callback host except loopback HTTP.
      const remote = normalizeRemoteAddress(remoteAddressOf ? remoteAddressOf(request) : request.socket?.remoteAddress);
      if (!isLoopbackAddress(remote)) {
        return sendJson(response, 403, { code: 'CALLBACK_LOCALHOST_ONLY', message: 'Approval callback accepts loopback only' });
      }
      if (request.method === 'GET') {
        const token = new URL(request.url, 'http://127.0.0.1').searchParams.get('token');
        if (!token) return sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'token is required' });
        const actionHash = challenges.get(token);
        if (!actionHash) return sendHtml(response, 404, 'Approval not found', 'This approval token is unknown or already used.');
        try {
          await release(actionHash);
        } catch {
          return sendHtml(response, 404, 'Approval not found', 'This approval token is unknown or already used.');
        }
        return sendHtml(response, 200, 'Approved', 'The held envelope was released to this host.');
      }
      if (request.method !== 'POST') return sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST' });
      if (!secretEqual(bearerToken(request.headers.authorization), callbackSecret)) {
        return sendJson(response, 401, { code: 'UNAUTHORIZED', message: 'Callback bearer is required' });
      }
      let body;
      try { body = JSON.parse(await readBody(request, maxBodyBytes)); }
      catch (error) {
        if (error.code === 'REQUEST_TOO_LARGE') return sendJson(response, 413, { code: error.code, message: error.message });
        return sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'Callback body must be JSON' });
      }
      if (!/^[0-9a-f]{64}$/.test(body?.action_hash ?? '')) {
        return sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'action_hash must be a sha256 hex digest' });
      }
      try {
        await release(body.action_hash);
      } catch {
        return sendJson(response, 404, { code: 'HELD_ENVELOPE_NOT_FOUND', message: 'Held envelope not found' });
      }
      return sendJson(response, 200, { status: 'RELEASED', action_hash: body.action_hash });
    } catch (error) {
      return sendJson(response, 500, { code: error.code ?? 'CALLBACK_FAILED', message: error.message });
    }
  }

  return {
    handleDispatch,
    handleCallback,
    async holdForApproval(envelope, token) {
      const held = await heldQueue.holdForApproval(envelope, token);
      challenges.set(held.challengeId, held.actionHash);
      return held;
    },
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

export async function listenTincanRelay(relay, { dispatchHost = '127.0.0.1', dispatchPort = 0, callbackHost = '127.0.0.1', callbackPort = 0 } = {}) {
  const dispatchServer = http.createServer(relay.handleDispatch);
  const callbackServer = http.createServer(relay.handleCallback);
  const boundDispatch = await listen(dispatchServer, dispatchHost, dispatchPort);
  let boundCallback;
  try {
    boundCallback = await listen(callbackServer, callbackHost, callbackPort);
  } catch (error) {
    dispatchServer.close();
    throw error;
  }
  return {
    dispatchPort: boundDispatch,
    callbackPort: boundCallback,
    callbackUrl: `http://127.0.0.1:${boundCallback}${CALLBACK_PATH}`,
    async close() {
      for (const server of [dispatchServer, callbackServer]) server.closeAllConnections?.();
      await Promise.all([dispatchServer, callbackServer].map((server) => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })));
    },
  };
}

export function parseTincanArgs(argv) {
  const opts = { port: 8794, callbackPort: 8795, host: '127.0.0.1', tailnet: false, config: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') opts.help = true;
    else if (arg === '--tailnet') opts.tailnet = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--callback-port') opts.callbackPort = Number(argv[++i]);
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg === '--config') opts.config = argv[++i];
    else throw refuse('INVALID_REQUEST', `Unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.config) throw refuse('INVALID_REQUEST', '--config is required');
  if (!Number.isInteger(opts.port) || !Number.isInteger(opts.callbackPort)) throw refuse('INVALID_REQUEST', 'Ports must be integers');
  return opts;
}

export function createSpawnWakeDispatcher() {
  return createWakeDispatcher({
    checkRunningFn: async () => false,
    spawnFn(command, args) {
      const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.unref();
      return child;
    },
  });
}

const USAGE = `Usage: node sigil/relay/v1/transport-tincan/tincan-relay.mjs --config <file> [--port 8794] [--callback-port 8795] [--host 127.0.0.1] [--tailnet]

--tailnet binds dispatch to this machine's Tailscale IPv4 address. The approval callback stays on 127.0.0.1.
TINCAN_CALLBACK_SECRET is required. TINCAN_RELAY_TOKEN is the agent bearer used for invocations/fail.`;

async function main() {
  const opts = parseTincanArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const callbackSecret = process.env.TINCAN_CALLBACK_SECRET;
  if (!callbackSecret) throw refuse('CONFIG_INVALID', 'TINCAN_CALLBACK_SECRET is required');
  const { allowlist, endpoints } = await loadTincanConfig(opts.config);
  const relayUrl = endpoints.values().next().value?.relayUrl;
  const token = process.env.TINCAN_RELAY_TOKEN;
  const failFn = async (roomId, reason, invocationId) => {
    if (!token || !relayUrl) throw refuse('INVOCATION_FAIL_UNAVAILABLE', 'TINCAN_RELAY_TOKEN is required to fail an invocation');
    const client = new RelayClient({ baseUrl: relayUrl, token });
    await client.failRoomInvocation(roomId, reason, invocationId);
  };
  let callbackUrl = `http://127.0.0.1:${opts.callbackPort}${CALLBACK_PATH}`;
  const heldQueue = createHeldQueue({
    callbackUrl: () => callbackUrl,
    submitChallengeFn: async (body, bearer) => {
      const client = new RelayClient({ baseUrl: relayUrl, token: bearer });
      return client.request('/v1/approval-challenges', { method: 'POST', body: JSON.stringify(body) });
    },
  });
  const relay = createTincanRelay({
    allowlist,
    tailscale: createTailscaleWhoIs(),
    dispatcher: createSpawnWakeDispatcher(),
    heldQueue,
    failFn,
    callbackSecret,
    endpoints,
  });
  const host = opts.tailnet
    ? (await execFileAsync('tailscale', ['ip', '-4'], { windowsHide: true, timeout: 8000 })).stdout.trim()
    : opts.host;
  const listening = await listenTincanRelay(relay, {
    dispatchHost: host,
    dispatchPort: opts.port,
    callbackHost: '127.0.0.1',
    callbackPort: opts.callbackPort,
  });
  callbackUrl = listening.callbackUrl;
  process.stdout.write(`tincan dispatch http://${host}:${listening.dispatchPort}${DISPATCH_PATH}\n`);
  process.stdout.write(`tincan callback ${listening.callbackUrl}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
