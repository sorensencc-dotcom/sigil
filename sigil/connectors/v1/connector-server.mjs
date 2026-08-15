import http from 'node:http';
import crypto from 'node:crypto';
import { validateConnectorRequest } from './connector-contract.mjs';
import { verifyPluginManifest } from './plugin-manifest.mjs';
import { capabilityForOperation } from './capability-policy.mjs';
import { resolveContext } from './context-resolver.mjs';

const routes = new Map([
  ['POST /v1/tasks', 'sendTask'], ['GET /v1/inbox', 'checkInbox'], ['GET /v1/results', 'getResult'],
  ['POST /v1/approvals', 'requestApproval'], ['POST /v1/context', 'resolveContext'],
  ['POST /v1/process', 'processDelivery'], ['POST /v1/results', 'submitResult']
]);

async function readBody(request, maxBytes = 1024 * 1024) {
  let raw = ''; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' }); raw += chunk; }
  return raw;
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}

export function createConnectorServer({ connector, token, manifest, publisherKeys, revokedPublisherKeys = new Set(), allowedCallers = [], maxInFlight = 32, maxRequestsPerWindow = 120, rateWindowMs = 60_000, contextRoot, contextGrants = [], resolveCaller } = {}) {
  if (!connector || !token) throw new Error('connector and token are required');
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || !Number.isInteger(maxRequestsPerWindow) || maxRequestsPerWindow < 1 || !Number.isInteger(rateWindowMs) || rateWindowMs < 1) throw new Error('invalid connector abuse limits');
  const verifiedManifest = manifest ? verifyPluginManifest(manifest, { publisherKeys, revokedPublisherKeys }) : null;
  const callerAllowList = new Set(allowedCallers);
  const idempotency = new Map();
  let inFlight = 0;
  const callerWindows = new Map();
  const server = http.createServer(async (request, response) => {
    const expected = `Bearer ${token}`;
    if (request.headers.authorization !== expected) return reply(response, 401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    const now = Date.now();
    const caller = resolveCaller ? await resolveCaller(request) : token;
    const window = callerWindows.get(caller) ?? { started: now, requests: 0 };
    if (now - window.started >= rateWindowMs) { window.started = now; window.requests = 0; }
    if (inFlight >= maxInFlight) return reply(response, 503, { code: 'BACKPRESSURE', message: 'Connector capacity is temporarily exhausted' });
    if (window.requests >= maxRequestsPerWindow) return reply(response, 429, { code: 'RATE_LIMITED', message: 'Connector request rate limit exceeded' });
    window.requests += 1; callerWindows.set(caller, window); if (callerWindows.size > 1000) for (const [key, value] of callerWindows) { if (now - value.started >= rateWindowMs) callerWindows.delete(key); } inFlight += 1;
    const operation = routes.get(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
    if (!operation || (operation !== 'resolveContext' || !contextRoot) && typeof connector[operation] !== 'function') return reply(response, 404, { code: 'CONTEXT_NOT_FOUND', message: 'Route not found' });
    try {
      const url = new URL(request.url, 'http://localhost');
      let input = {};
      if (request.method === 'GET') input = url.searchParams.get('task_id') ?? url.searchParams.get('since') ?? '';
      else { const raw = await readBody(request); input = raw ? JSON.parse(raw) : {}; }
      const contract = validateConnectorRequest({ headers: request.headers, body: typeof input === 'object' ? input : {} });
      if (callerAllowList.size && !callerAllowList.has(contract.caller)) throw Object.assign(new Error('caller is not allowed'), { code: 'CALLER_NOT_ALLOWED' });
      if (verifiedManifest && request.headers['x-sigil-package-id'] !== verifiedManifest.package_id) throw Object.assign(new Error('package identity mismatch'), { code: 'PACKAGE_ID_MISMATCH' });
      const requiredCapability = capabilityForOperation(operation);
      if (requiredCapability && !contract.scope.startsWith(requiredCapability) && !contract.scope.endsWith('/*')) throw Object.assign(new Error('request capability does not match operation'), { code: 'CAPABILITY_DENIED' });
      const idempotencyKey = request.headers['x-sigil-idempotency-key'];
      const fingerprint = idempotencyKey ? crypto.createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex') : null;
      if (idempotencyKey) {
        if (!/^[A-Za-z0-9._~-]{1,200}$/.test(idempotencyKey)) throw Object.assign(new Error('Invalid idempotency key'), { code: 'INVALID_IDEMPOTENCY_KEY' });
        const prior = idempotency.get(idempotencyKey);
        if (prior && prior.fingerprint !== fingerprint) throw Object.assign(new Error('Idempotency key conflicts with prior request'), { code: 'IDEMPOTENCY_CONFLICT' });
        if (prior) return reply(response, prior.status, prior.body);
      }
      const result = operation === 'resolveContext' && contextRoot
        ? await resolveContext(input, { root: contextRoot, grants: contextGrants, caller })
        : operation === 'checkInbox' ? await connector.checkInbox(input) : operation === 'getResult' ? await connector.getResult(input.task_id ?? input) : await connector[operation](input);
      const body = { code: 'OK', result };
      if (idempotencyKey) idempotency.set(idempotencyKey, { fingerprint, status: 200, body });
      return reply(response, 200, body);
    } catch (error) { return reply(response, error.code === 'REQUEST_TOO_LARGE' ? 413 : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : error.code === 'VERSION_UNSUPPORTED' ? 426 : error.code === 'CALLER_NOT_ALLOWED' || error.code === 'PACKAGE_ID_MISMATCH' || error.code === 'CAPABILITY_DENIED' ? 403 : 400, { code: error.code ?? 'INVALID_ENVELOPE', message: error.message }); }
    finally { inFlight -= 1; }
  });
  return { server, listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), address: () => server.address(), close: () => new Promise((resolve) => server.close(resolve)) };
}

export function createConnectorToken() { return crypto.randomBytes(32).toString('base64url'); }
