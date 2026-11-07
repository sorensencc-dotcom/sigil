// sigil/connectors/v1/mcp-memory-bridge.mjs
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function createMcpMemoryBridge({ kbServerPath } = {}) {
  const resolvedPath = kbServerPath || path.resolve('C:/dev/kb-sync/scripts/mcp-memory-server.mjs');
  let kbModulePromise = null;

  async function getKbModule() {
    if (!kbModulePromise) {
      kbModulePromise = import(pathToFileURL(resolvedPath).href);
    }
    return kbModulePromise;
  }

  const sseSessions = new Map();

  function setCors(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-sigil-idempotency-key');
  }

  async function readBody(request, maxBytes = 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' });
      chunks.push(b);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }

  async function handleRequest(request, response) {
    const parsedUrl = new URL(request.url, 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '');

    if (!pathname.startsWith('/mcp/memory')) {
      return false;
    }

    setCors(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return true;
    }

    let kb;
    try {
      kb = await getKbModule();
    } catch (err) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `Failed to load kb-sync memory server: ${err.message}` } }));
      return true;
    }

    const db = kb.daemonDatabase();

    // 1. SSE Connection: GET /mcp/memory or GET /mcp/memory/sse
    if (request.method === 'GET' && (pathname === '/mcp/memory' || pathname === '/mcp/memory/sse')) {
      const sessionId = crypto.randomUUID();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      // Emit endpoint event
      response.write(`event: endpoint\ndata: /mcp/memory/message?sessionId=${sessionId}\n\n`);

      const pingInterval = setInterval(() => {
        try {
          response.write(': ping\n\n');
        } catch {
          clearInterval(pingInterval);
        }
      }, 15000);

      sseSessions.set(sessionId, { response, pingInterval });

      request.on('close', () => {
        clearInterval(pingInterval);
        sseSessions.delete(sessionId);
      });

      return true;
    }

    // 2. Message Post: POST /mcp/memory/message or direct POST /mcp/memory
    if (request.method === 'POST') {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      let bodyText;
      try {
        bodyText = await readBody(request);
      } catch (err) {
        response.writeHead(err.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: err.message }));
        return true;
      }

      let rpcMessage;
      try {
        rpcMessage = JSON.parse(bodyText);
      } catch (err) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }));
        return true;
      }

      const rpcResponse = kb.processRpcMessage(db, rpcMessage);

      // If tied to an active SSE session, send response over SSE
      if (sessionId && sseSessions.has(sessionId)) {
        if (rpcResponse) {
          const session = sseSessions.get(sessionId);
          session.response.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
        }
        response.writeHead(202, { 'Content-Type': 'text/plain' });
        response.end('Accepted');
        return true;
      }

      // Otherwise direct HTTP JSON-RPC response
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(rpcResponse || { jsonrpc: '2.0', id: rpcMessage.id ?? null, result: {} }));
      return true;
    }

    response.writeHead(405, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return true;
  }

  return {
    handleRequest,
    getSessionsCount: () => sseSessions.size,
    close: () => {
      for (const [id, session] of sseSessions) {
        clearInterval(session.pingInterval);
        try { session.response.end(); } catch {}
      }
      sseSessions.clear();
    }
  };
}
