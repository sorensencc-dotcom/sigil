import http from 'node:http';
import crypto from 'node:crypto';

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

export function createConnectorServer({ connector, token } = {}) {
  if (!connector || !token) throw new Error('connector and token are required');
  const server = http.createServer(async (request, response) => {
    const expected = `Bearer ${token}`;
    if (request.headers.authorization !== expected) return reply(response, 401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    const operation = routes.get(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
    if (!operation || typeof connector[operation] !== 'function') return reply(response, 404, { code: 'CONTEXT_NOT_FOUND', message: 'Route not found' });
    try {
      const url = new URL(request.url, 'http://localhost');
      let input = {};
      if (request.method === 'GET') input = url.searchParams.get('task_id') ?? url.searchParams.get('since') ?? '';
      else { const raw = await readBody(request); input = raw ? JSON.parse(raw) : {}; }
      const result = operation === 'checkInbox' ? await connector.checkInbox(input) : operation === 'getResult' ? await connector.getResult(input.task_id ?? input) : await connector[operation](input);
      return reply(response, 200, { code: 'OK', result });
    } catch (error) { return reply(response, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { code: error.code ?? 'INVALID_ENVELOPE', message: error.message }); }
  });
  return { server, listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), address: () => server.address(), close: () => new Promise((resolve) => server.close(resolve)) };
}

export function createConnectorToken() { return crypto.randomBytes(32).toString('base64url'); }
