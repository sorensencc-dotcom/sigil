// sigil/connectors/v1/mcp-memory-bridge.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_CHARS,
  normalizeRelativePath,
  verifyHandoffMemory,
} from '../../contracts/v1/handoff-memory-gate.mjs';

// kb-sync's vfs_upsert_document files each document as wiki/{category}/{topic}.md
// and refuses anything outside wiki/. Verified handoff files go in wiki/handoff/.
export const HANDOFF_MEMORY_CATEGORY = 'handoff';
const HANDOFF_WIKI_ROOT = `wiki/${HANDOFF_MEMORY_CATEGORY}`;

// Same rule as kb-sync's sanitizeTopic, so the topic we send is the one it stores.
function kebabTopic(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Maps a handoff bundle file path to kb-sync vfs_upsert_document arguments.
 * 'handoff/decisions.md' and 'decisions.md' both land at
 * wiki/handoff/decisions.md; subfolders are kept, and a missing .md is added.
 * Returns null for a path the handoff gate would reject.
 */
export function handoffMemoryDocument(filePath) {
  const rel = normalizeRelativePath(filePath);
  if (!rel) return null;
  let inner = rel.startsWith(`${HANDOFF_MEMORY_CATEGORY}/`) ? rel.slice(HANDOFF_MEMORY_CATEGORY.length + 1) : rel;
  if (!inner) return null;
  if (!/\.md$/i.test(inner)) inner = `${inner}.md`;
  const topic = kebabTopic(inner.replace(/\.md$/i, '').replace(/\//g, '-'));
  if (!topic) return null;
  return { topic, category: HANDOFF_MEMORY_CATEGORY, file_path: `${HANDOFF_WIKI_ROOT}/${inner}` };
}

const HANDOFF_MEMORY_TOOL = Object.freeze({
  name: 'commit_handoff_memory',
  description: `Verifies a concise handoff memory bundle (<= ${MAX_HANDOFF_FILES} files, <= ${MAX_HANDOFF_CHARS} chars) against a signed Sigil room transcript before persisting files to local memory.`,
  inputSchema: {
    type: 'object',
    properties: {
      handoff: { type: 'object', description: 'Handoff memory bundle with files and transcript-backed assertions' },
      transcript: { type: 'object', description: 'Exported sigil.room-transcript v1 document. Cited entries must be signed by a key the connector is configured to trust.' },
      maxFiles: { type: 'integer', maximum: MAX_HANDOFF_FILES },
      maxChars: { type: 'integer', maximum: MAX_HANDOFF_CHARS },
    },
    required: ['handoff'],
  },
});

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
        topic: { type: 'string' },
        category: { type: 'string' },
        content: { type: 'string' },
        file_path: { type: 'string' }
      },
      required: ['topic', 'category', 'content']
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

// A tools/call can report failure as a JSON-RPC error or, per MCP, as a
// result with isError set (kb-sync's vfs_upsert_document does the latter).
function toolCallFailure(response) {
  if (!response || typeof response !== 'object') return { message: 'no response from memory backend' };
  if (response.error) return response.error;
  if (response.result?.isError) {
    const text = Array.isArray(response.result.content)
      ? response.result.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join(' ')
      : '';
    return { message: text || 'memory backend reported an error', result: response.result };
  }
  return null;
}

/**
 * handoffTrustedKeys: Ed25519 keys ({ endpoint_id, key_id, public_key_spki })
 * whose signatures commit_handoff_memory accepts as evidence. Caller-supplied
 * pins are ignored, since a caller could pin a key it generated itself. With
 * no trusted keys configured, commit_handoff_memory refuses every handoff.
 */
export function createMcpMemoryBridge({ kbServerPath, kbModule, handoffTrustedKeys = [] } = {}) {
  const trustedKeys = Array.isArray(handoffTrustedKeys) ? handoffTrustedKeys : [];
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

      let rpcResponse;
      if (rpcMessage?.method === 'tools/call' && rpcMessage?.params?.name === 'commit_handoff_memory') {
        const args = rpcMessage.params.arguments ?? {};
        const verdict = await verifyHandoffMemory(args.handoff, {
          transcript: args.transcript,
          pinnedKeys: trustedKeys,
          requirePinnedSigners: true,
          requireFileAssertions: true,
          maxFiles: args.maxFiles ?? args.max_files,
          maxChars: args.maxChars ?? args.max_chars,
        });
        if (!trustedKeys.length) {
          rpcResponse = {
            jsonrpc: '2.0',
            id: rpcMessage.id ?? null,
            error: {
              code: -32003,
              message: 'Handoff memory rejected: no trusted signer keys are configured for this connector',
              data: verdict,
            },
          };
        } else if (!verdict.ok) {
          rpcResponse = {
            jsonrpc: '2.0',
            id: rpcMessage.id ?? null,
            error: {
              code: -32003,
              message: `Handoff memory rejected: ${verdict.problems[0]?.code ?? 'VERIFICATION_FAILED'}`,
              data: verdict,
            },
          };
        } else {
          const committedFiles = [];
          const memoryPaths = [];
          let upsertFailure = null;
          const files = Array.isArray(args.handoff?.files) ? args.handoff.files : [];
          for (let idx = 0; idx < files.length; idx += 1) {
            const file = files[idx];
            const doc = handoffMemoryDocument(file.path);
            if (!doc) {
              upsertFailure = { file: file.path, error: { message: 'path cannot be mapped to a wiki document' } };
              break;
            }
            const upsertRes = kb.processRpcMessage(db, {
              jsonrpc: '2.0',
              id: `${rpcMessage.id ?? 'handoff'}:file:${idx}`,
              method: 'tools/call',
              params: {
                name: 'vfs_upsert_document',
                arguments: { ...doc, content: file.content },
              },
            });
            const failure = toolCallFailure(upsertRes);
            if (failure) {
              upsertFailure = { file: file.path, error: failure };
              break;
            }
            committedFiles.push(file.path);
            memoryPaths.push(doc.file_path);
          }
          if (upsertFailure) {
            rpcResponse = {
              jsonrpc: '2.0',
              id: rpcMessage.id ?? null,
              error: {
                code: -32603,
                message: `Failed to persist verified handoff file ${upsertFailure.file}: ${upsertFailure.error.message ?? 'unknown error'}. ${committedFiles.length} earlier file(s) were already written and were not rolled back.`,
                data: { committed_files: committedFiles, memory_paths: memoryPaths, failed_file: upsertFailure.file, cause: upsertFailure.error },
              },
            };
          } else {
            rpcResponse = {
              jsonrpc: '2.0',
              id: rpcMessage.id ?? null,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: true,
                      room_id: verdict.room_id,
                      committed_files: committedFiles,
                      memory_paths: memoryPaths,
                      checked_entries: verdict.checked_entries,
                      checked_assertions: verdict.checked_assertions,
                      budget: verdict.budget,
                    }),
                  },
                ],
              },
            };
          }
        }
      } else {
        rpcResponse = kb.processRpcMessage(db, rpcMessage);
        if (rpcMessage?.method === 'tools/list' && Array.isArray(rpcResponse?.result?.tools)) {
          const hasTool = rpcResponse.result.tools.some((tool) => tool?.name === HANDOFF_MEMORY_TOOL.name);
          if (!hasTool) {
            rpcResponse = {
              ...rpcResponse,
              result: {
                ...rpcResponse.result,
                tools: [...rpcResponse.result.tools, HANDOFF_MEMORY_TOOL],
              },
            };
          }
        }
      }

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
