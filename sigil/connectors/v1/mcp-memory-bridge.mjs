// sigil/connectors/v1/mcp-memory-bridge.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const FALLBACK_TOOLS = [
  {
    name: 'query_context_cache',
    description: 'Searches the knowledge base context cache by query string.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or question' },
        limit: { type: 'integer', default: 5 }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_topic_note',
    description: 'Fetches topic notes and citations by topic name.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Canonical topic name' }
      },
      required: ['topic']
    }
  },
  {
    name: 'vfs_upsert_document',
    description: 'Upserts document to local cache.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  }
];

function createFallbackKb() {
  return {
    daemonDatabase: () => ({}),
    processRpcMessage: (_db, message) => {
      if (!message || typeof message !== 'object') {
        return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      }
      const { id, method, params } = message;
      if (id === undefined || id === null) {
        return null;
      }
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params?.protocolVersion || '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'kb-context-cache', version: '1.0.0' }
            }
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: FALLBACK_TOOLS }
          };
        case 'tools/call': {
          const { name } = params || {};
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `[fallback-cache] Tool ${name} handled with empty result.`
                }
              ]
            }
          };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          };
      }
    }
  };
}

export function createMcpMemoryBridge({ kbServerPath, kbModule } = {}) {
  let kbModulePromise = null;

  async function getKbModule() {
    if (kbModule) return kbModule;
    if (kbModulePromise) return kbModulePromise;

    const candidates = [
      kbServerPath,
      process.env.KB_MEMORY_SERVER_PATH,
      path.resolve(import.meta.dirname, '../../../../kb-sync/scripts/mcp-memory-server.mjs'),
      'C:/dev/kb-sync/scripts/mcp-memory-server.mjs'
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          kbModulePromise = await import(pathToFileURL(candidate).href);
          return kbModulePromise;
        } catch {
          // Fall through to next candidate or fallback
        }
      }
    }

    kbModulePromise = createFallbackKb();
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
