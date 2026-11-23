// Disposable kb-sync memory server for contract tests. Loaded by the bridge via
// KB_MEMORY_SERVER_PATH. Reads notes from the JSON file named by KB_FIXTURE_CACHE.
import fs from 'node:fs';

const TOOLS = ['query_context_cache', 'fetch_topic_note'].map((name) => ({
  name,
  description: `fixture ${name}`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}));

export function daemonDatabase() {
  return JSON.parse(fs.readFileSync(process.env.KB_FIXTURE_CACHE, 'utf8'));
}

export function processRpcMessage(db, { id, method, params }) {
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return ok({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kb-fixture', version: '0.0.0' } });
  }
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call' && params?.name === 'query_context_cache') {
    const q = String(params.arguments?.query ?? '').toLowerCase();
    const hits = db.notes.filter((n) => n.text.toLowerCase().includes(q));
    return ok({ content: [{ type: 'text', text: hits.map((n) => `${n.topic}: ${n.text}`).join('\n') }] });
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
